import Foundation
import os

private let log = Logger(subsystem: "halo.runtime", category: "server")

/// One-line state for the in-process child runtime.
///
/// `external` is the developer mode: something is already listening on the
/// runtime port (a `bun run src/server.ts` in a terminal, or a previous
/// instance the OS hasn't reaped yet) so we attach instead of spawning.
enum RuntimeProcessState: Equatable, Sendable {
    case notStarted
    case probing
    case starting
    case running(pid: Int32)
    case external          // someone else owns the port
    case crashed(reason: String)
    case stopped

    var label: String {
        switch self {
        case .notStarted:        return "not started"
        case .probing:           return "probing"
        case .starting:          return "starting"
        case .running(let pid):  return "running (pid \(pid))"
        case .external:          return "external (attached)"
        case .crashed(let r):    return "crashed: \(r)"
        case .stopped:           return "stopped"
        }
    }

    var isUp: Bool {
        switch self {
        case .running, .external: return true
        default: return false
        }
    }
}

/// Owns the lifecycle of the bundled `halo-runtime` (Bun) child process.
///
/// On `start()` we probe `127.0.0.1:<port>/v1/health` first. If something
/// answers, we attach (state = .external) and never spawn — that's the
/// developer-running-server-in-terminal case. Otherwise we spawn the
/// bundled binary, wire stdout/stderr to a log file, and watch for exit.
///
/// On crash we restart once. A second crash leaves us in `.crashed(...)`
/// and surfaces to the UI rather than thrashing.
///
/// Override behavior with environment variables (set in Xcode scheme):
///   HALO_NO_SPAWN=1           — never spawn, only attach
///   HALO_RUNTIME_BINARY=path  — explicit binary path (skips bundle lookup)
@MainActor
final class RuntimeServer {
    static let shared = RuntimeServer()

    /// One-shot override for the next spawn's MODEL_BASE_URL. Set by
    /// AppDelegate.bootInferenceStack when bundled mode has no usable
    /// model — the harness still needs *some* working endpoint, so we
    /// transparently point it at the user's external URL for this boot.
    /// Cleared after the spawn consumes it.
    var nextSpawnURLOverride: String?

    private(set) var state: RuntimeProcessState = .notStarted {
        didSet {
            log.info("state → \(self.state.label, privacy: .public)")
            onStateChange?(state)
        }
    }
    var onStateChange: ((RuntimeProcessState) -> Void)?

    /// Where stdout/stderr from the child get appended.
    let logFileURL: URL

    private let port: Int
    private var process: Process?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private var logHandle: FileHandle?

    /// Crash budget — how many auto-restarts we'll do per app session before
    /// giving up. Reset on a successful run that survives `crashGraceSeconds`.
    private var restartsRemaining = 1
    private var lastSpawnAt: Date?
    private static let crashGraceSeconds: TimeInterval = 10

    init(port: Int = 7878) {
        self.port = port

        // ~/Library/Logs/HaloApp/runtime.log — standard macOS log location,
        // rotates on the user's normal log discipline. Falls back to /tmp
        // if Library/Logs isn't writable for some reason.
        let logsDir: URL
        if let lib = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first {
            logsDir = lib.appendingPathComponent("Logs/HaloApp", isDirectory: true)
        } else {
            logsDir = URL(fileURLWithPath: "/tmp")
        }
        try? FileManager.default.createDirectory(at: logsDir, withIntermediateDirectories: true)
        self.logFileURL = logsDir.appendingPathComponent("runtime.log")
    }

    // MARK: - Public lifecycle

    /// Idempotent. Probes the port, attaches if something's there, otherwise
    /// spawns the bundled binary. Safe to call multiple times.
    func start() async {
        guard !state.isUp else { return }

        if ProcessInfo.processInfo.environment["HALO_NO_SPAWN"] == "1" {
            log.info("HALO_NO_SPAWN set — attach-only mode")
            state = .probing
            if await healthOK() {
                state = .external
            } else {
                state = .crashed(reason: "HALO_NO_SPAWN=1 but nothing on :\(port)")
            }
            return
        }

        state = .probing
        if await healthOK() {
            log.info("port :\(self.port, privacy: .public) already serving — attaching")
            state = .external
            return
        }

        await spawn()
    }

    /// SIGTERM → wait up to 3s → SIGKILL. Safe to call when not running.
    func stop() {
        guard let p = process, p.isRunning else {
            state = .stopped
            return
        }
        log.info("terminating pid \(p.processIdentifier)")
        p.terminate()  // SIGTERM

        // Give the child a beat to flush + exit cleanly.
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if p.isRunning {
            log.info("SIGTERM ignored — sending SIGKILL")
            kill(p.processIdentifier, SIGKILL)
        }
        process = nil
        state = .stopped
    }

    /// Stop (if running) and start again — used when a setting change
    /// (e.g. endpoint URL) needs the runtime to pick up new env. If we
    /// only attached to an external runtime, restart is a no-op except
    /// for re-running the probe (the external owner manages its own
    /// lifecycle).
    func restart() async {
        if case .external = state {
            log.info("restart skipped — runtime is external (attached, not spawned)")
            // Re-probe so the UI reflects whatever's there now.
            state = .probing
            if await healthOK() { state = .external } else { await spawn() }
            return
        }
        stop()
        // Reset crash budget — an explicit restart shouldn't count
        // against the auto-recovery limit.
        restartsRemaining = 1
        await start()
    }

    // MARK: - Spawn

    private func spawn() async {
        guard let binary = locateBinary() else {
            state = .crashed(reason: "halo-runtime binary not found (run scripts/build-runtime.sh)")
            return
        }

        state = .starting

        // Open the log file once per spawn — append, so prior runs are
        // preserved for post-crash inspection.
        if !FileManager.default.fileExists(atPath: logFileURL.path) {
            FileManager.default.createFile(atPath: logFileURL.path, contents: nil)
        }
        let handle = try? FileHandle(forWritingTo: logFileURL)
        _ = try? handle?.seekToEnd()
        let header = "\n=== \(ISO8601DateFormatter().string(from: Date())) — spawn \(binary.path) ===\n"
        try? handle?.write(contentsOf: Data(header.utf8))
        logHandle = handle

        let p = Process()
        p.executableURL = binary
        p.arguments = []
        var env = ProcessInfo.processInfo.environment
        env["HALO_PORT"] = String(port)
        env["HALO_LOG_QUIET"] = env["HALO_LOG_QUIET"] ?? "0"
        // Death-pact: child polls this pid every 2s and exits if we're
        // gone. Defends against the parent app crashing / being SIGKILLed
        // before applicationWillTerminate gets a chance to call stop().
        env["HALO_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        // Make sure HOME is set — the runtime resolves ~/.assistant/ from it.
        if env["HOME"] == nil {
            env["HOME"] = NSHomeDirectory()
        }
        // Tell the harness which inference endpoint to use. The Mac app is
        // the orchestrator (design.md §3.8) — the harness must not hold
        // its own opinion. An ambient process-env override still wins, so
        // dev workflows that pre-set MODEL_BASE_URL keep working.
        if env["MODEL_BASE_URL"] == nil {
            // One-shot override (bundled-fallback case) wins over
            // AppState's resolved URL. Cleared after consumption.
            if let override = nextSpawnURLOverride {
                env["MODEL_BASE_URL"] = override
                nextSpawnURLOverride = nil
            } else {
                env["MODEL_BASE_URL"] = AppState.shared.resolvedModelBaseURL
            }
        }
        p.environment = env

        let outPipe = Pipe()
        let errPipe = Pipe()
        p.standardOutput = outPipe
        p.standardError = errPipe
        stdoutPipe = outPipe
        stderrPipe = errPipe

        // Tee child output into the log file, line by line.
        let teeHandler: (FileHandle) -> Void = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty else { return }
            try? self?.logHandle?.write(contentsOf: data)
        }
        outPipe.fileHandleForReading.readabilityHandler = teeHandler
        errPipe.fileHandleForReading.readabilityHandler = teeHandler

        p.terminationHandler = { [weak self] proc in
            // Hop to the main actor before mutating state.
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
        log.info("spawned pid \(p.processIdentifier) — \(binary.path, privacy: .public)")

        // Wait for the health endpoint to come up (or timeout). The runtime
        // does some startup work — model discovery, embedder probe, index
        // open — so first health may take 1–2s on a cold LM Studio.
        let ok = await waitForHealth(timeout: 15)
        if ok {
            state = .running(pid: p.processIdentifier)
        } else if p.isRunning {
            // Process is alive but hasn't answered yet — still call it
            // running. Better to optimistically mark up than confuse the UI
            // when a slow boot is still legitimate.
            state = .running(pid: p.processIdentifier)
            log.info("spawn alive but health didn't respond in 15s — leaving as running")
        }
        // If !p.isRunning, terminationHandler already fired or will fire and
        // set the state.
    }

    private func handleTermination(reason: Process.TerminationReason, status: Int32) {
        let why = "\(reason == .uncaughtSignal ? "signal" : "exit") \(status)"
        log.error("child exited: \(why, privacy: .public)")

        // Clean up pipes so we don't leak FDs.
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil
        try? logHandle?.close()
        stdoutPipe = nil
        stderrPipe = nil
        logHandle = nil
        process = nil

        // Survived long enough? Restore the restart budget.
        if let last = lastSpawnAt, Date().timeIntervalSince(last) > Self.crashGraceSeconds {
            restartsRemaining = 1
        }

        // If we explicitly asked it to stop (state is already .stopped),
        // don't restart — that's just clean shutdown.
        if case .stopped = state { return }

        if restartsRemaining > 0 {
            restartsRemaining -= 1
            log.info("restarting once after crash (budget remaining: \(self.restartsRemaining))")
            Task { @MainActor [weak self] in
                await self?.spawn()
            }
        } else {
            state = .crashed(reason: why)
        }
    }

    // MARK: - Locate the binary

    /// Bundle.main first (production), then a couple of dev fallbacks so
    /// you can run from Xcode without re-bundling each time.
    private func locateBinary() -> URL? {
        // Explicit override (Xcode scheme env var) wins.
        if let override = ProcessInfo.processInfo.environment["HALO_RUNTIME_BINARY"] {
            let url = URL(fileURLWithPath: override)
            if FileManager.default.isExecutableFile(atPath: url.path) {
                return url
            }
            log.error("HALO_RUNTIME_BINARY=\(override, privacy: .public) not executable")
            // Fall through to other lookups.
        }

        if let bundled = Bundle.main.url(forResource: "halo-runtime", withExtension: nil),
           FileManager.default.isExecutableFile(atPath: bundled.path) {
            return bundled
        }

        // Dev fallback: walk up from the .app's location to find the repo
        // root (heuristic: a directory containing scripts/build-runtime.sh
        // and a halo-runtime sibling).
        var dir = Bundle.main.bundleURL.deletingLastPathComponent()
        for _ in 0..<10 {
            let candidate = dir.appendingPathComponent("halo-runtime")
            let scriptMarker = dir.appendingPathComponent("scripts/build-runtime.sh")
            if FileManager.default.fileExists(atPath: scriptMarker.path),
               FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
            let parent = dir.deletingLastPathComponent()
            if parent == dir { break }
            dir = parent
        }

        // Last-resort hardcoded dev path (your machine).
        let hardcoded = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("workspace/ollama/halo-runtime")
        if FileManager.default.isExecutableFile(atPath: hardcoded.path) {
            return hardcoded
        }
        return nil
    }

    // MARK: - Health probe

    private func healthOK() async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/v1/health") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 0.5
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
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        return false
    }
}
