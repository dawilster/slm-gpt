import Foundation
import os

private let log = Logger(subsystem: "halo.runtime", category: "modelserver")

/// State of the bundled llama-server (inference) process. Distinct from
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

/// Owns the lifecycle of the bundled `llama-server` process — the
/// second instance of the orchestrator pattern (design.md §3.8). The
/// Mac app spawns this *first*, waits for it to come up, then spawns
/// the harness with `MODEL_BASE_URL` pointed at it.
///
/// Listens on :1235 (vs LM Studio's conventional :1234). Spawned with
/// `--model <gguf-path> --port 1235 --ctx-size N`. Crashes on its own
/// when the model file is corrupt; we surface that as `.crashed` and
/// the AppDelegate decides whether to fall back to external mode.
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

    /// Where stdout/stderr from llama-server gets appended.
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
        self.logFileURL = logsDir.appendingPathComponent("llama-server.log")
    }

    /// Resolved URL the harness should use to reach this server.
    var modelBaseURL: String { "http://127.0.0.1:\(port)/v1" }

    // MARK: - Public lifecycle

    /// Spawn llama-server pointed at the GGUF for `modelId`. Idempotent
    /// — calling with the same modelId while already running is a no-op.
    /// Calling with a different modelId stops the current one first.
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
            state = .crashed(reason: "llama-server binary not found in bundle (run scripts/build-llama-server.sh)")
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
        // Reasonable defaults. Context size is a deliberate floor —
        // we'll surface this as a load-time setting in v8.5+ once the
        // load-time-vs-request-time settings split lands.
        p.arguments = [
            "--model", entry.installedURL.path,
            "--port", String(port),
            "--host", "127.0.0.1",
            "--ctx-size", "4096",
            "--n-gpu-layers", "999",  // offload everything to Metal — fastest on Apple Silicon
            "--alias", entry.id,       // shows up as the OpenAI model name
            "--log-prefix",            // colorless line prefixes, cleaner in our log file
        ]
        var env = ProcessInfo.processInfo.environment
        // Death-pact: the supervisor wrapper polls this pid and SIGKILLs
        // llama-server when the Mac app dies. Without it the model server
        // orphans to launchd holding ~3GB of RAM with the GGUF mmap'd.
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
        log.error("llama-server exited: \(why, privacy: .public)")

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

    private func locateBinary() -> URL? {
        // We invoke the *supervisor* shell wrapper, not llama-server
        // directly — the wrapper handles parent-pid death-pact and
        // exec's llama-server next to it. Sits in the same dir so
        // @loader_path dylib resolution still works.
        let wrapperName = "llama-server-supervised.sh"

        if let res = Bundle.main.resourceURL?.appendingPathComponent("llama-runtime/\(wrapperName)"),
           FileManager.default.isExecutableFile(atPath: res.path) {
            return res
        }
        // Dev fallback: prebuilt llama-runtime/ at repo root, plus the
        // wrapper from scripts/. We need both — locate the wrapper
        // (in scripts/) and copy it next to llama-server on first call.
        var dir = Bundle.main.bundleURL.deletingLastPathComponent()
        for _ in 0..<10 {
            let candidate = dir.appendingPathComponent("llama-runtime/\(wrapperName)")
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
            // Wrapper not yet copied — copy it from scripts/ if both exist.
            let wrapperSrc = dir.appendingPathComponent("scripts/\(wrapperName)")
            let runtimeDir = dir.appendingPathComponent("llama-runtime")
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
            .appendingPathComponent("workspace/ollama/llama-runtime/\(wrapperName)")
        if FileManager.default.isExecutableFile(atPath: hardcoded.path) {
            return hardcoded
        }
        return nil
    }

    private func healthOK() async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/v1/models") else { return false }
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
