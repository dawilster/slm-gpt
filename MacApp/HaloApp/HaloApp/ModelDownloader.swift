import Foundation
import os

private let log = Logger(subsystem: "halo.runtime", category: "downloader")

/// Lifecycle of a single model download. Mirrors the design.md §3.8
/// requirement for resume-on-flaky-wifi + integrity verification.
enum DownloadState: Equatable, Sendable {
    case idle
    case running(progress: Double, bytesPerSec: Int64)
    case verifying
    case finished
    case failed(reason: String)

    var progress: Double {
        switch self {
        case .running(let p, _): return p
        case .verifying:         return 1.0
        case .finished:          return 1.0
        default:                 return 0
        }
    }

    var isActive: Bool {
        switch self {
        case .running, .verifying: return true
        default: return false
        }
    }
}

/// Downloads every file in a HuggingFace MLX repo at a pinned revision
/// into a local directory. Sequential per-file (network-bound either
/// way; one big SwiftLM/MLX model is a few large safetensors + a
/// dozen small JSONs). Resumable: skips files that already exist with
/// the expected size; partial files are kept across pause/restart.
///
/// Why not per-file SHA256 verification: HF's tree API gives sha256
/// for LFS files (the big safetensors) but only git-blob sha1 for
/// non-LFS files. We pin the *revision* (commit SHA) instead, which
/// is the integrity contract. Per-file LFS sha256 verification is a
/// future hardening pass; for now we trust HF's TLS + the pinned rev.
@MainActor
final class ModelDownloader: NSObject {
    let modelId: String
    let huggingfaceRepo: String
    let huggingfaceRevision: String
    let expectedTotalBytes: Int64
    let destinationDirectory: URL

    /// Live observable state — the UI binds to this.
    private(set) var state: DownloadState = .idle {
        didSet { onStateChange?(state) }
    }
    var onStateChange: ((DownloadState) -> Void)?

    private var session: URLSession!
    private var currentTask: URLSessionDataTask?
    private var currentFileHandle: FileHandle?

    /// Cumulative bytes across all files in this download (including
    /// already-present files). Drives the progress fraction.
    private var totalWrittenBytes: Int64 = 0
    private var sampleAt: Date = .now
    private var sampleBytes: Int64 = 0
    private var cancelled = false

    init(
        modelId: String,
        huggingfaceRepo: String,
        huggingfaceRevision: String,
        expectedTotalBytes: Int64,
        destinationDirectory: URL
    ) {
        self.modelId = modelId
        self.huggingfaceRepo = huggingfaceRepo
        self.huggingfaceRevision = huggingfaceRevision
        self.expectedTotalBytes = expectedTotalBytes
        self.destinationDirectory = destinationDirectory
        super.init()

        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 60 * 60 * 24
        cfg.waitsForConnectivity = true
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: cfg, delegate: self, delegateQueue: .main)
    }

    // MARK: - Public control

    /// Kick off the download. Idempotent — already-running is a no-op.
    func start() {
        if state.isActive { return }
        if case .finished = state { return }

        cancelled = false
        try? FileManager.default.createDirectory(at: destinationDirectory, withIntermediateDirectories: true)

        Task { await self.runDownload() }
    }

    /// Cancel the in-flight download. Files already written to disk
    /// stay (start() resumes by skipping them). Use ModelCatalog.
    /// cancelOrDelete to also wipe the directory.
    func cancel() {
        cancelled = true
        currentTask?.cancel()
        currentTask = nil
        try? currentFileHandle?.close()
        currentFileHandle = nil
        if !state.isActive { return }
        state = .idle
    }

    // MARK: - Orchestration

    private func runDownload() async {
        state = .running(progress: 0, bytesPerSec: 0)
        sampleAt = .now
        sampleBytes = 0

        // Fetch the file tree at the pinned revision.
        let files: [HFRepoFile]
        do {
            files = try await fetchRepoTree()
        } catch {
            state = .failed(reason: "couldn't list HF tree: \(error.localizedDescription)")
            return
        }

        // Skip git-internal files. README is informational; .gitattributes
        // controls LFS routing on the server side, not relevant locally.
        let toDownload = files.filter { !$0.path.hasPrefix(".") }

        // Pre-count bytes already on disk so the progress bar starts
        // accurate when resuming.
        totalWrittenBytes = toDownload.reduce(into: 0) { acc, f in
            let dst = destinationDirectory.appendingPathComponent(f.path)
            if let attrs = try? FileManager.default.attributesOfItem(atPath: dst.path),
               let size = attrs[.size] as? Int64,
               size == f.size {
                acc += size
            }
        }
        emitProgress(force: true)

        for file in toDownload {
            if cancelled { return }
            let dst = destinationDirectory.appendingPathComponent(file.path)
            // Already-correct file? Skip. Wrong-size? Re-download.
            if let attrs = try? FileManager.default.attributesOfItem(atPath: dst.path),
               let size = attrs[.size] as? Int64,
               size == file.size {
                continue
            }
            do {
                try await downloadFile(file)
            } catch {
                if cancelled { return }
                state = .failed(reason: "\(file.path): \(error.localizedDescription)")
                return
            }
        }

        state = .finished
        log.info("downloaded \(self.modelId, privacy: .public) (\(self.totalWrittenBytes) bytes)")
    }

    private func emitProgress(force: Bool = false) {
        let now = Date()
        let elapsed = now.timeIntervalSince(sampleAt)
        guard force || elapsed >= 0.1 else { return }
        let bytes = totalWrittenBytes - sampleBytes
        let bps = elapsed > 0 ? Int64(Double(bytes) / elapsed) : 0
        sampleAt = now
        sampleBytes = totalWrittenBytes
        let frac = expectedTotalBytes > 0
            ? min(1.0, Double(totalWrittenBytes) / Double(expectedTotalBytes))
            : 0
        state = .running(progress: frac, bytesPerSec: bps)
    }

    // MARK: - HF tree

    private struct HFRepoFile: Decodable {
        let path: String
        let size: Int64
        let type: String  // "file" or "directory"
    }

    private func fetchRepoTree() async throws -> [HFRepoFile] {
        // HF API: https://huggingface.co/api/models/{repo}/tree/{revision}
        let urlStr = "https://huggingface.co/api/models/\(huggingfaceRepo)/tree/\(huggingfaceRevision)"
        guard let url = URL(string: urlStr) else {
            throw NSError(domain: "halo.downloader", code: -1, userInfo: [NSLocalizedDescriptionKey: "bad URL: \(urlStr)"])
        }
        let (data, resp) = try await URLSession.shared.data(from: url)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw NSError(domain: "halo.downloader", code: code, userInfo: [NSLocalizedDescriptionKey: "HF tree HTTP \(code)"])
        }
        let all = try JSONDecoder().decode([HFRepoFile].self, from: data)
        return all.filter { $0.type == "file" }
    }

    // MARK: - Per-file streaming download

    private func downloadFile(_ file: HFRepoFile) async throws {
        let dst = destinationDirectory.appendingPathComponent(file.path)
        // Ensure parent dirs exist (for sharded models with subdirs).
        try FileManager.default.createDirectory(
            at: dst.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        // Resume from .partial if present.
        let partial = dst.appendingPathExtension("partial")
        let resumeFrom: Int64 = (try? FileHandle(forReadingFrom: partial).seekToEnd()).map(Int64.init) ?? 0

        if !FileManager.default.fileExists(atPath: partial.path) {
            FileManager.default.createFile(atPath: partial.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: partial)
        try handle.seekToEnd()
        currentFileHandle = handle
        // Account for resumed bytes in cumulative total.
        totalWrittenBytes += resumeFrom
        emitProgress(force: true)

        let resolveURL = "https://huggingface.co/\(huggingfaceRepo)/resolve/\(huggingfaceRevision)/\(file.path)"
        guard let url = URL(string: resolveURL) else {
            throw NSError(domain: "halo.downloader", code: -1, userInfo: [NSLocalizedDescriptionKey: "bad resolve URL"])
        }
        var req = URLRequest(url: url)
        if resumeFrom > 0 {
            req.setValue("bytes=\(resumeFrom)-", forHTTPHeaderField: "Range")
        }

        // Run the data task and await completion via continuation.
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            let task = session.dataTask(with: req)
            currentTask = task
            // Stash the continuation so the delegate methods can fire it.
            self.currentContinuation = cont
            self.currentExpectedSize = file.size
            self.currentResumeBytes = resumeFrom
            self.currentDestPartial = partial
            self.currentDestFinal = dst
            task.resume()
        }
    }

    // Per-task scratch state — set in downloadFile, read by delegates.
    private var currentContinuation: CheckedContinuation<Void, Error>?
    private var currentExpectedSize: Int64 = 0
    private var currentResumeBytes: Int64 = 0
    private var currentDestPartial: URL?
    private var currentDestFinal: URL?

    private func finishCurrent(_ result: Result<Void, Error>) {
        currentTask = nil
        try? currentFileHandle?.close()
        currentFileHandle = nil
        let cont = currentContinuation
        currentContinuation = nil
        cont?.resume(with: result)
    }
}

// MARK: - URLSessionDataDelegate

extension ModelDownloader: URLSessionDataDelegate {
    nonisolated func urlSession(_ session: URLSession,
                                dataTask: URLSessionDataTask,
                                didReceive response: URLResponse,
                                completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let http = response as? HTTPURLResponse {
            if http.statusCode == 200 {
                // Server ignored Range header — restart from zero.
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    log.info("server returned 200 (no range support) — restarting file from zero")
                    try? self.currentFileHandle?.truncate(atOffset: 0)
                    // Roll back the previously-credited resume bytes.
                    self.totalWrittenBytes -= self.currentResumeBytes
                    self.currentResumeBytes = 0
                }
            } else if http.statusCode != 206 && http.statusCode != 200 {
                Task { @MainActor [weak self] in
                    self?.finishCurrent(.failure(NSError(
                        domain: "halo.downloader",
                        code: http.statusCode,
                        userInfo: [NSLocalizedDescriptionKey: "HTTP \(http.statusCode)"]
                    )))
                }
                completionHandler(.cancel)
                return
            }
        }
        completionHandler(.allow)
    }

    nonisolated func urlSession(_ session: URLSession,
                                dataTask: URLSessionDataTask,
                                didReceive data: Data) {
        Task { @MainActor [weak self] in
            guard let self, !self.cancelled else { return }
            do {
                try self.currentFileHandle?.write(contentsOf: data)
            } catch {
                self.currentTask?.cancel()
                self.finishCurrent(.failure(error))
                return
            }
            self.totalWrittenBytes += Int64(data.count)
            self.emitProgress()
        }
    }

    nonisolated func urlSession(_ session: URLSession,
                                task: URLSessionTask,
                                didCompleteWithError error: Error?) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            try? self.currentFileHandle?.close()
            self.currentFileHandle = nil

            if let error = error as NSError? {
                if error.code == NSURLErrorCancelled && self.cancelled { return }
                if error.code == NSURLErrorCancelled { return }
                self.finishCurrent(.failure(error))
                return
            }

            // Atomic rename .partial → final destination.
            if let partial = self.currentDestPartial, let dst = self.currentDestFinal {
                do {
                    if FileManager.default.fileExists(atPath: dst.path) {
                        try FileManager.default.removeItem(at: dst)
                    }
                    try FileManager.default.moveItem(at: partial, to: dst)
                } catch {
                    self.finishCurrent(.failure(error))
                    return
                }
            }
            self.finishCurrent(.success(()))
        }
    }
}
