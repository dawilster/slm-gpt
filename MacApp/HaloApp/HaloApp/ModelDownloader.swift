import Foundation
import CryptoKit
import os

private let log = Logger(subsystem: "halo.runtime", category: "downloader")

/// Lifecycle of a single model download. Mirrors the design.md §3.8
/// requirement for resume-on-flaky-wifi + SHA256 integrity.
enum DownloadState: Equatable, Sendable {
    case idle
    case running(progress: Double, bytesPerSec: Int64)
    case paused(progress: Double)
    case verifying
    case finished
    case failed(reason: String)

    var progress: Double {
        switch self {
        case .running(let p, _): return p
        case .paused(let p):     return p
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

/// Downloads one GGUF file at a time. Resumable across pause/resume and
/// across app restarts — the partial file lives at `<dest>.partial` and
/// the next start sends a `Range: bytes=<size>-` request.
///
/// Verification: streams the bytes through a CryptoKit SHA256 as we
/// write, so verifying is free (no second pass over the file). On
/// mismatch the partial file is deleted to force a clean retry.
@MainActor
final class ModelDownloader: NSObject {
    let modelId: String
    let url: URL
    let expectedSHA256: String
    let expectedSize: Int64
    let destinationURL: URL

    /// Live observable state — the UI binds to this.
    private(set) var state: DownloadState = .idle {
        didSet { onStateChange?(state) }
    }
    var onStateChange: ((DownloadState) -> Void)?

    private var session: URLSession!
    private var task: URLSessionDataTask?
    private var fileHandle: FileHandle?
    private var hasher = SHA256()
    private var bytesWritten: Int64 = 0
    private var sampleAt: Date = .now
    private var sampleBytes: Int64 = 0

    init(modelId: String, url: URL, expectedSHA256: String, expectedSize: Int64, destinationURL: URL) {
        self.modelId = modelId
        self.url = url
        self.expectedSHA256 = expectedSHA256.lowercased()
        self.expectedSize = expectedSize
        self.destinationURL = destinationURL
        super.init()

        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 60 * 60 * 24  // 24h — multi-GB on slow wifi is fine
        cfg.waitsForConnectivity = true
        cfg.networkServiceType = .background
        // Don't let URLCache intercept multi-GB transfers.
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: cfg, delegate: self, delegateQueue: .main)
    }

    deinit {
        // task?.cancel()  // can't call on deinit from MainActor
    }

    var partialURL: URL { destinationURL.appendingPathExtension("partial") }

    // MARK: - Public control

    /// Start (or resume) the download. Idempotent — calling while
    /// already running is a no-op.
    func start() {
        if case .running = state { return }
        if case .verifying = state { return }
        if case .finished = state { return }

        // If destination exists, we're done — verify-on-disk and finish.
        if FileManager.default.fileExists(atPath: destinationURL.path) {
            Task { await verifyExistingFile() }
            return
        }

        // Resume from .partial if present.
        let resumeFrom: Int64 = (try? FileHandle(forReadingFrom: partialURL).seekToEnd()).map(Int64.init) ?? 0

        // Open the partial file for append. Create if it doesn't exist.
        try? FileManager.default.createDirectory(at: destinationURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: partialURL.path) {
            FileManager.default.createFile(atPath: partialURL.path, contents: nil)
        }
        do {
            fileHandle = try FileHandle(forWritingTo: partialURL)
            try fileHandle?.seekToEnd()
        } catch {
            state = .failed(reason: "couldn't open partial file: \(error.localizedDescription)")
            return
        }

        // Reset hasher and re-hash already-written bytes if resuming.
        // For multi-GB resumes this is a real cost — but it's the only
        // way to verify the final SHA without trusting the partial bytes
        // blindly. Worth it.
        hasher = SHA256()
        bytesWritten = 0
        if resumeFrom > 0 {
            log.info("resuming \(self.modelId, privacy: .public) from \(resumeFrom) bytes — rehashing partial")
            do {
                let reader = try FileHandle(forReadingFrom: partialURL)
                while true {
                    let chunk = try reader.read(upToCount: 256 * 1024)
                    if let chunk, !chunk.isEmpty {
                        hasher.update(data: chunk)
                        bytesWritten += Int64(chunk.count)
                    } else {
                        break
                    }
                }
                try reader.close()
            } catch {
                log.error("rehash failed: \(error.localizedDescription, privacy: .public) — restarting")
                hasher = SHA256()
                bytesWritten = 0
                try? fileHandle?.truncate(atOffset: 0)
            }
        }

        var req = URLRequest(url: url)
        if bytesWritten > 0 {
            req.setValue("bytes=\(bytesWritten)-", forHTTPHeaderField: "Range")
        }
        sampleAt = .now
        sampleBytes = bytesWritten

        let t = session.dataTask(with: req)
        task = t
        state = .running(progress: progressFraction(), bytesPerSec: 0)
        t.resume()
    }

    /// Pause the active download. Bytes written so far stay in `.partial`
    /// — `start()` later will resume.
    func pause() {
        guard case .running(let p, _) = state else { return }
        task?.cancel()
        task = nil
        try? fileHandle?.close()
        fileHandle = nil
        state = .paused(progress: p)
    }

    /// Cancel + delete the partial file. Used by Settings → Delete.
    func cancelAndDelete() {
        task?.cancel()
        task = nil
        try? fileHandle?.close()
        fileHandle = nil
        try? FileManager.default.removeItem(at: partialURL)
        try? FileManager.default.removeItem(at: destinationURL)
        bytesWritten = 0
        hasher = SHA256()
        state = .idle
    }

    // MARK: - Internals

    private func progressFraction() -> Double {
        guard expectedSize > 0 else { return 0 }
        return min(1.0, Double(bytesWritten) / Double(expectedSize))
    }

    private func verifyExistingFile() async {
        state = .verifying
        do {
            let h = try await Task.detached(priority: .userInitiated) { [destinationURL] in
                try Self.fileSHA256(at: destinationURL)
            }.value
            if h == expectedSHA256 {
                state = .finished
            } else {
                try? FileManager.default.removeItem(at: destinationURL)
                state = .failed(reason: "checksum mismatch on existing file")
            }
        } catch {
            state = .failed(reason: "verify failed: \(error.localizedDescription)")
        }
    }

    nonisolated private static func fileSHA256(at url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let chunk = try handle.read(upToCount: 1024 * 1024) ?? Data()
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - URLSessionDataDelegate

extension ModelDownloader: URLSessionDataDelegate {
    nonisolated func urlSession(_ session: URLSession,
                                dataTask: URLSessionDataTask,
                                didReceive response: URLResponse,
                                completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        // Validate response code. 206 = partial content (resume worked),
        // 200 = full content (server ignored Range — restart from zero).
        if let http = response as? HTTPURLResponse {
            if http.statusCode == 200 {
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    log.info("server returned 200 (no range support) — restarting from zero")
                    self.bytesWritten = 0
                    self.hasher = SHA256()
                    try? self.fileHandle?.truncate(atOffset: 0)
                    self.sampleBytes = 0
                    self.sampleAt = .now
                }
            } else if http.statusCode != 206 && http.statusCode != 200 {
                Task { @MainActor [weak self] in
                    self?.state = .failed(reason: "HTTP \(http.statusCode)")
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
            guard let self else { return }
            do {
                try self.fileHandle?.write(contentsOf: data)
                self.hasher.update(data: data)
                self.bytesWritten += Int64(data.count)
            } catch {
                log.error("write failed: \(error.localizedDescription, privacy: .public)")
                self.task?.cancel()
                self.state = .failed(reason: "disk write: \(error.localizedDescription)")
                return
            }

            // Throttle UI updates to ~10/s so SwiftUI isn't overwhelmed.
            let now = Date()
            let elapsed = now.timeIntervalSince(self.sampleAt)
            if elapsed >= 0.1 {
                let bytes = self.bytesWritten - self.sampleBytes
                let bps = Int64(Double(bytes) / elapsed)
                self.sampleAt = now
                self.sampleBytes = self.bytesWritten
                self.state = .running(progress: self.progressFraction(), bytesPerSec: bps)
            }
        }
    }

    nonisolated func urlSession(_ session: URLSession,
                                task: URLSessionTask,
                                didCompleteWithError error: Error?) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            try? self.fileHandle?.close()
            self.fileHandle = nil

            if let error = error as NSError? {
                // Cancel from pause()/cancelAndDelete() is a normal exit —
                // state is already correct.
                if error.code == NSURLErrorCancelled { return }
                log.error("download failed: \(error.localizedDescription, privacy: .public)")
                self.state = .failed(reason: error.localizedDescription)
                return
            }

            // All bytes received — verify SHA matches.
            self.state = .verifying
            let actual = self.hasher.finalize().map { String(format: "%02x", $0) }.joined()
            if actual == self.expectedSHA256 {
                // Move .partial → final destination.
                do {
                    if FileManager.default.fileExists(atPath: self.destinationURL.path) {
                        try FileManager.default.removeItem(at: self.destinationURL)
                    }
                    try FileManager.default.moveItem(at: self.partialURL, to: self.destinationURL)
                    self.state = .finished
                } catch {
                    self.state = .failed(reason: "rename failed: \(error.localizedDescription)")
                }
            } else {
                log.error("checksum mismatch — expected \(self.expectedSHA256, privacy: .public), got \(actual, privacy: .public)")
                try? FileManager.default.removeItem(at: self.partialURL)
                self.state = .failed(reason: "checksum mismatch")
            }
        }
    }
}
