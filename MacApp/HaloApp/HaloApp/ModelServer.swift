import Foundation
import os

private let log = Logger(subsystem: "halo.runtime", category: "modelserver")

/// State of the bundled MLX inference server process. Distinct from
/// RuntimeProcessState — that's about the harness, this is about the
/// model server underneath it. The Mac app spawns both.
enum ModelServerState: Equatable, Sendable {
    case notStarted
    case starting(modelId: String)
    case running(pid: Int32, modelId: String)
    case crashed(reason: String)
    case stopped

    var label: String {
        switch self {
        case .notStarted:                  return "not started"
        case .starting(let m):             return "loading \(m)"
        case .running(let pid, let m):     return "\(m) (pid \(pid))"
        case .crashed(let r):              return "crashed: \(r)"
        case .stopped:                     return "stopped"
        }
    }

    var isUp: Bool {
        if case .running = self { return true }
        return false
    }
}

/// Owns the lifecycle of the bundled MLX inference server — the second
/// instance of the orchestrator pattern (design.md §3.8). The Mac app
/// spawns this *first*, waits for it to come up, then spawns the
/// harness with `MODEL_BASE_URL` pointed at it.
///
/// The server itself is `python-runtime/serve.py` (FastAPI shim around
/// mlx-lm + mlx-vlm), launched via the `python-supervised.sh` wrapper.
/// It listens on :1235 (vs LM Studio's conventional :1234) and exposes
/// the OpenAI-compat surface the harness already speaks. Spawned with
/// `--model <local-mlx-dir> --port 1235`. We use a local directory
/// path rather than a HuggingFace ID so the user's selected catalog
/// model (downloaded into our own storage with our SHA-pinned
/// integrity check) is what actually loads.
///
/// Why Python+mlx-lm/mlx-vlm vs SwiftLM: SwiftLM (a native Swift+MLX
/// server) couldn't load Qwen3.5-2B-6bit because mlx-community's
/// VLM packaging doesn't match SwiftLM's loader expectations. The
/// Python ecosystem (what LM Studio uses internally) tracks
/// bleeding-edge model support — we get every new mlx-community
/// model "for free" without waiting on SwiftLM updates. Bundle size
/// went from ~190MB → ~300MB; the trade is worth it. See
/// design.md decision log 2026-05-05.
///
/// Why MLX over llama.cpp/GGUF: design.md §3.8 originally chose
/// llama-server for portability, but we now target M-series only — so
/// MLX wins on tok/s (25 vs 20 in our perf eval), keeps parity with
/// the user's existing mlx-community model collection, and avoids
/// architecture-support gaps.
@MainActor
final class ModelServer {
    static let shared = ModelServer()

    /// Listening port. Distinct from RuntimeServer's :7878 and from the
    /// external-endpoint convention :1234 — a fixed port keeps the
    /// orchestration trivial and matches §3.8's MODEL_BASE_URL=:1235.
    let port: Int = 1235

    private(set) var state: ModelServerState = .notStarted {
        didSet {
            log.info("state → \(self.state.label, privacy: .public)")
            onStateChange?(state)
        }
    }
    var onStateChange: ((ModelServerState) -> Void)?

    /// Where stdout/stderr from the Python MLX server gets appended.
    let logFileURL: URL

    private var process: Process?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private var logHandle: FileHandle?
    private var currentModelId: String?

    private var restartsRemaining = 1
    private var lastSpawnAt: Date?
    private static let crashGraceSeconds: TimeInterval = 30  // model load can take ~10s

    init() {
        let logsDir: URL
        if let lib = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first {
            logsDir = lib.appendingPathComponent("Logs/HaloApp", isDirectory: true)
        } else {
            logsDir = URL(fileURLWithPath: "/tmp")
        }
        try? FileManager.default.createDirectory(at: logsDir, withIntermediateDirectories: true)
        // Filename retains "llama-server" for log-archive continuity —
        // older builds wrote here, and the contents are still "the
        // bundled inference server", just now Python+MLX.
        self.logFileURL = logsDir.appendingPathComponent("llama-server.log")
    }

    /// Resolved URL the harness should use to reach this server.
    var modelBaseURL: String { "http://127.0.0.1:\(port)/v1" }

    // MARK: - Public lifecycle

    /// Spawn the Python MLX server pointed at the model directory for
    /// `modelId`. Idempotent — calling with the same modelId while
    /// already running is a no-op. Calling with a different modelId
    /// stops the current one first.
    func start(modelId: String) async {
        if case .running(_, let current) = state, current == modelId { return }
        if case .starting(let current) = state, current == modelId { return }

        if process != nil {
            stop()
        }

        guard let entry = ModelCatalog.shared.entries.first(where: { $0.id == modelId }) else {
            state = .crashed(reason: "unknown model id: \(modelId)")
            return
        }
        guard FileManager.default.fileExists(atPath: entry.installedURL.path) else {
            state = .crashed(reason: "model not downloaded: \(modelId)")
            return
        }
        guard let binary = locateBinary() else {
            state = .crashed(reason: "python-runtime not found in bundle (run scripts/fetch-python-mlx.sh)")
            return
        }

        currentModelId = modelId
        state = .starting(modelId: modelId)

        // Open the log file once per spawn — append, so prior runs are
        // preserved for post-crash inspection.
        if !FileManager.default.fileExists(atPath: logFileURL.path) {
            FileManager.default.createFile(atPath: logFileURL.path, contents: nil)
        }
        let handle = try? FileHandle(forWritingTo: logFileURL)
        _ = try? handle?.seekToEnd()
        let header = "\n=== \(ISO8601DateFormatter().string(from: Date())) — spawn \(binary.path) --model \(entry.installedURL.lastPathComponent) ===\n"
        try? handle?.write(contentsOf: Data(header.utf8))
        logHandle = handle

        let p = Process()
        p.executableURL = binary
        // Context size comes from the catalog (32K typical for Qwen3
        // family). KV cache cost: roughly 0.5MB/token at f16, so a 32K
        // context budget is ~16GB of headroom — fine on M-series with
        // mmap'd weights but we cap at 8K on 8GB Macs to leave room for
        // user apps. Surfaces as a load-time setting in v8.5+.
        //
        // No --vision flag needed: serve.py auto-detects VLMs by
        // inspecting config.json for a `vision_config` block and
        // routes through mlx-vlm vs mlx-lm accordingly.
        let contextLimit = ramAdjustedContext(for: entry.model)
        p.arguments = [
            "--model", entry.installedURL.path,  // local MLX directory
            "--port", String(port),
            "--host", "127.0.0.1",
            "--ctx-size", String(contextLimit),
        ]
        var env = ProcessInfo.processInfo.environment
        // Death-pact: the supervisor wrapper polls this pid and
        // SIGKILLs the python child when the Mac app dies. serve.py
        // also has its own in-process watchdog as belt-and-braces.
        // Without these, the model server orphans to launchd holding
        // ~3-4GB of RAM with the model loaded.
        env["HALO_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        p.environment = env

        let outPipe = Pipe()
        let errPipe = Pipe()
        p.standardOutput = outPipe
        p.standardError = errPipe
        stdoutPipe = outPipe
        stderrPipe = errPipe

        let teeHandler: (FileHandle) -> Void = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty else { return }
            try? self?.logHandle?.write(contentsOf: data)
        }
        outPipe.fileHandleForReading.readabilityHandler = teeHandler
        errPipe.fileHandleForReading.readabilityHandler = teeHandler

        p.terminationHandler = { [weak self] proc in
            Task { @MainActor [weak self] in
                self?.handleTermination(reason: proc.terminationReason, status: proc.terminationStatus)
            }
        }

        do {
            try p.run()
        } catch {
            state = .crashed(reason: "spawn failed: \(error.localizedDescription)")
            return
        }
        process = p
        lastSpawnAt = Date()
        log.info("spawned pid \(p.processIdentifier) for \(modelId, privacy: .public)")

        // Wait for the OpenAI-compat endpoint to come up. Loading a 4GB
        // model from disk can take 5-15s on a cold M1; budget generously.
        let ok = await waitForHealth(timeout: 60)
        if ok {
            state = .running(pid: p.processIdentifier, modelId: modelId)
        } else if !p.isRunning {
            // terminationHandler will set the state.
        } else {
            // Optimistically mark running — health may just be slow.
            state = .running(pid: p.processIdentifier, modelId: modelId)
            log.info("spawn alive but health didn't respond in 60s — leaving as running")
        }
    }

    /// SIGTERM → wait up to 5s → SIGKILL. Safe to call when not running.
    func stop() {
        guard let p = process, p.isRunning else {
            state = .stopped
            return
        }
        log.info("terminating pid \(p.processIdentifier)")
        p.terminate()
        let deadline = Date().addingTimeInterval(5)
        while p.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if p.isRunning {
            log.info("SIGTERM ignored — sending SIGKILL")
            kill(p.processIdentifier, SIGKILL)
        }
        process = nil
        currentModelId = nil
        state = .stopped
    }

    // MARK: - Internals

    private func handleTermination(reason: Process.TerminationReason, status: Int32) {
        let why = "\(reason == .uncaughtSignal ? "signal" : "exit") \(status)"
        log.error("python MLX server exited: \(why, privacy: .public)")

        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil
        try? logHandle?.close()
        stdoutPipe = nil
        stderrPipe = nil
        logHandle = nil
        process = nil

        if let last = lastSpawnAt, Date().timeIntervalSince(last) > Self.crashGraceSeconds {
            restartsRemaining = 1
        }

        if case .stopped = state { return }

        if let modelId = currentModelId, restartsRemaining > 0 {
            restartsRemaining -= 1
            log.info("restarting once after crash (budget remaining: \(self.restartsRemaining))")
            Task { @MainActor [weak self] in
                await self?.start(modelId: modelId)
            }
        } else {
            state = .crashed(reason: why)
        }
    }

    /// Conservative context budget — the catalog's nominal context vs
    /// what's safe given the host's RAM. KV cache scales linearly with
    /// context, and on an 8GB Mac with a 4B model loaded we have very
    /// little headroom for it. Mirrors design.md §3.5 strategy #2
    /// (adaptive context budget).
    private func ramAdjustedContext(for model: CatalogModel) -> Int {
        let nominal = max(2048, model.context)
        // Floor based on RAM tier. 8GB → 8K cap, 16GB → 16K, 24GB+ → no cap.
        let cap: Int
        switch SystemInfo.totalRAMGB {
        case ..<12:  cap = 8192
        case 12..<20: cap = 16384
        default:     cap = nominal
        }
        return min(nominal, cap)
    }

    private func locateBinary() -> URL? {
        // We invoke the *supervisor* shell wrapper, not python directly
        // — the wrapper handles parent-pid death-pact, sets up the
        // python invocation (`python3 serve.py ...`), and forwards args.
        let wrapperName = "python-supervised.sh"

        // Production: the wrapper lives inside the bundled
        // python-runtime/ dir, ditto'd into Resources/ by Xcode.
        if let res = Bundle.main.resourceURL?.appendingPathComponent("python-runtime/\(wrapperName)"),
           FileManager.default.isExecutableFile(atPath: res.path) {
            return res
        }
        // Dev fallback: walk up looking for the repo's python-runtime/
        // dir. The fetch-python-mlx.sh script puts the wrapper inside
        // it (alongside bin/python3 and serve.py). If we find the dir
        // but no wrapper, copy the source-controlled one from scripts/.
        var dir = Bundle.main.bundleURL.deletingLastPathComponent()
        for _ in 0..<10 {
            let candidate = dir.appendingPathComponent("python-runtime/\(wrapperName)")
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
            let wrapperSrc = dir.appendingPathComponent("scripts/\(wrapperName)")
            let runtimeDir = dir.appendingPathComponent("python-runtime")
            if FileManager.default.isExecutableFile(atPath: wrapperSrc.path),
               FileManager.default.fileExists(atPath: runtimeDir.path) {
                let dst = runtimeDir.appendingPathComponent(wrapperName)
                try? FileManager.default.copyItem(at: wrapperSrc, to: dst)
                if FileManager.default.isExecutableFile(atPath: dst.path) {
                    return dst
                }
            }
            let parent = dir.deletingLastPathComponent()
            if parent == dir { break }
            dir = parent
        }
        // Last-resort hardcoded dev path.
        let hardcoded = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("workspace/ollama/python-runtime/\(wrapperName)")
        if FileManager.default.isExecutableFile(atPath: hardcoded.path) {
            return hardcoded
        }
        return nil
    }

    /// True only when serve.py is fully loaded and ready to accept
    /// inference. serve.py loads the model synchronously *before*
    /// uvicorn binds the port, so by the time /health responds 200
    /// at all, generation is ready. /v1/models would also work but
    /// we use /health to keep the port-bind-vs-loaded distinction
    /// crisp if the loader behaviour ever changes.
    private func healthOK() async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.0
        let session = URLSession(configuration: .ephemeral)
        do {
            let (_, resp) = try await session.data(for: req)
            return (resp as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    private func waitForHealth(timeout: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await healthOK() { return true }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
        return false
    }
}
