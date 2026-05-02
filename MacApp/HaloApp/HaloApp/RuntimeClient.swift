import Foundation
import os

private let log = Logger(subsystem: "halo.runtime", category: "client")

// MARK: - Wire-protocol value types (must match src/server.ts)

struct ChatToolEvent: Decodable, Sendable {
    let step: Int
    let name: String
    let result: String
    let latencyMs: Int
    let isError: Bool
}

struct ChatDoneEvent: Decodable, Sendable {
    let promptTokens: Int
    let completionTokens: Int
    let latencyMs: Int
    let steps: Int
    let toolCallsExecuted: Int
    let sessionId: String
}

struct HealthResponse: Decodable, Sendable {
    let ok: Bool
    let port: Int
    let model: String
    let contextLimit: Int?
    let embeddings: String?
    let liveSessions: Int
}

struct ProfileFact: Decodable, Identifiable, Sendable, Equatable {
    let key: String
    let value: String
    var id: String { key }
}

struct ProfileResponse: Decodable, Sendable {
    let facts: [ProfileFact]
    let path: String
}

struct SessionMeta: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let path: String
    let startedAt: String
    let turnCount: Int
    let firstUserMessage: String?
}

struct SessionsResponse: Decodable, Sendable {
    let sessions: [SessionMeta]
}

struct SessionTurn: Decodable, Sendable, Equatable {
    let role: String      // "user" | "assistant"
    let text: String
    let ts: String
}

struct SessionDetailResponse: Decodable, Sendable {
    let id: String
    let messages: [SessionTurn]
    let meta: SessionMeta?
}

struct ShortcutEntry: Decodable, Identifiable, Sendable, Equatable {
    let name: String
    var id: String { name }
}

struct ShortcutsResponse: Decodable, Sendable {
    let shortcuts: [ShortcutEntry]
    let cachedAt: Int64
    let fromCache: Bool
}

/// Yielded events from `RuntimeClient.chat`. The Mac app folds these into
/// its `ChatSession` to drive the dock UI.
enum ChatEvent: Sendable {
    case session(id: String)
    case status(state: String)
    case tool(ChatToolEvent)
    /// Reasoning-content delta from a thinking-mode model (Qwen 3.5 +
    /// HALO_THINKING=1). Distinct from `.token` so the UI can render the
    /// trace in a separate (collapsible) surface.
    case thinking(text: String)
    case token(text: String)
    case done(ChatDoneEvent)
    case error(message: String)
}

// MARK: - HTTP client

/// Talks to the local Halo runtime daemon (Bun, src/server.ts).
/// Default endpoint is http://127.0.0.1:7878 — override via the
/// `HALO_RUNTIME_URL` UserDefaults key if needed.
final class RuntimeClient {
    static let shared = RuntimeClient()

    private let baseURL: URL

    init(baseURL: URL? = nil) {
        let override = UserDefaults.standard.string(forKey: "HALO_RUNTIME_URL")
            .flatMap(URL.init(string:))
        self.baseURL = baseURL ?? override ?? URL(string: "http://127.0.0.1:7878")!
    }

    /// Recent saved conversations, most-recent-first.
    func sessions(limit: Int = 10) async throws -> [SessionMeta] {
        var comps = URLComponents(url: baseURL.appendingPathComponent("v1/sessions"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
        let session = URLSession(configuration: .ephemeral)
        let (data, resp) = try await session.data(from: comps.url!)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw RuntimeError.notReachable
        }
        return try JSONDecoder().decode(SessionsResponse.self, from: data).sessions
    }

    /// Full transcript for a session (user + assistant turns only).
    func session(id: String) async throws -> SessionDetailResponse {
        let url = baseURL.appendingPathComponent("v1/sessions/\(percentEncode(id))")
        let session = URLSession(configuration: .ephemeral)
        let (data, resp) = try await session.data(from: url)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw RuntimeError.notReachable
        }
        return try JSONDecoder().decode(SessionDetailResponse.self, from: data)
    }

    /// Fetch the user's profile — every fact the assistant has remembered.
    func profile() async throws -> ProfileResponse {
        let url = baseURL.appendingPathComponent("v1/profile")
        let session = URLSession(configuration: .ephemeral)
        let (data, resp) = try await session.data(from: url)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw RuntimeError.notReachable
        }
        return try JSONDecoder().decode(ProfileResponse.self, from: data)
    }

    /// The user's macOS Shortcuts library, surfaced via the runtime so the
    /// app and the chat agent see the same set. Pass `force: true` to bust
    /// the runtime's ~30s cache (e.g. user just added one in Shortcuts.app).
    func shortcuts(force: Bool = false) async throws -> ShortcutsResponse {
        var comps = URLComponents(url: baseURL.appendingPathComponent("v1/shortcuts"), resolvingAgainstBaseURL: false)!
        if force {
            comps.queryItems = [URLQueryItem(name: "force", value: "1")]
        }
        let session = URLSession(configuration: .ephemeral)
        let (data, resp) = try await session.data(from: comps.url!)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw RuntimeError.notReachable
        }
        return try JSONDecoder().decode(ShortcutsResponse.self, from: data)
    }

    /// Forget a single fact. Returns true if anything was removed.
    @discardableResult
    func forget(key: String) async throws -> Bool {
        var req = URLRequest(url: baseURL.appendingPathComponent("v1/profile/\(percentEncode(key))"))
        req.httpMethod = "DELETE"
        let session = URLSession(configuration: .ephemeral)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw RuntimeError.notReachable
        }
        struct R: Decodable { let deleted: Bool }
        return (try? JSONDecoder().decode(R.self, from: data).deleted) ?? false
    }

    private func percentEncode(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }

    /// Probe the runtime daemon. Throws if it isn't running.
    func health() async throws -> HealthResponse {
        let url = baseURL.appendingPathComponent("v1/health")
        let session = URLSession(configuration: .ephemeral)
        do {
            let (data, resp) = try await session.data(from: url)
            guard let http = resp as? HTTPURLResponse else {
                throw RuntimeError.notReachable
            }
            if http.statusCode != 200 {
                log.error("health: HTTP \(http.statusCode)")
                throw RuntimeError.notReachable
            }
            return try JSONDecoder().decode(HealthResponse.self, from: data)
        } catch {
            log.error("health failed: \(error.localizedDescription, privacy: .public)")
            throw error
        }
    }

    /// Send a user message, yielding `ChatEvent`s as the server streams them.
    /// Pass `sessionId` to resume an existing conversation; pass nil to start
    /// a new one (the server returns the new id via the first `.session` event).
    nonisolated func chat(message: String, sessionId: String?) -> AsyncThrowingStream<ChatEvent, Error> {
        let url = baseURL.appendingPathComponent("v1/chat")
        log.debug("chat → POST \(url.absoluteString, privacy: .public) (\(message.count) chars, sid=\(sessionId ?? "new", privacy: .public))")

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json",  forHTTPHeaderField: "Content-Type")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("no-cache",          forHTTPHeaderField: "Cache-Control")
        let payload: [String: Any] = sessionId.map { ["message": message, "sessionId": $0] }
            ?? ["message": message]
        // Force-try is fine here — the JSON object is fully under our control.
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        return AsyncThrowingStream { continuation in
            // Delegate-based streaming bypasses URLSession.AsyncBytes.lines,
            // which has known issues stalling on chunked-transfer SSE.
            let delegate = SSEStreamDelegate(continuation: continuation)
            let cfg = URLSessionConfiguration.ephemeral
            cfg.timeoutIntervalForRequest  = 60
            cfg.timeoutIntervalForResource = 600
            let session = URLSession(configuration: cfg, delegate: delegate, delegateQueue: nil)
            let task = session.dataTask(with: req)
            continuation.onTermination = { _ in
                task.cancel()
                session.invalidateAndCancel()
            }
            task.resume()
        }
    }
}

// MARK: - SSE streaming delegate

/// URLSessionDataDelegate that incrementally parses the Server-Sent Events
/// wire format and feeds an AsyncThrowingStream continuation. Designed to
/// keep up with token-by-token streaming over `Transfer-Encoding: chunked`.
private final class SSEStreamDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let continuation: AsyncThrowingStream<ChatEvent, Error>.Continuation
    private var buffer = Data()
    private var pendingEvent: String?
    private var pendingDataLines: [String] = []
    private var emittedCount = 0
    private let decoder = JSONDecoder()

    init(continuation: AsyncThrowingStream<ChatEvent, Error>.Continuation) {
        self.continuation = continuation
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        if let http = response as? HTTPURLResponse {
            log.debug("chat ← HTTP \(http.statusCode)")
            if http.statusCode != 200 {
                continuation.finish(throwing: RuntimeError.httpStatus(http.statusCode))
                completionHandler(.cancel)
                return
            }
        }
        completionHandler(.allow)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive data: Data
    ) {
        buffer.append(data)
        // Drain every complete line out of the buffer.
        while let nl = buffer.firstIndex(of: 0x0A /* \n */) {
            let lineData = buffer.subdata(in: 0..<nl)
            buffer.removeSubrange(0...nl)

            // Strip a possible trailing CR (CRLF servers).
            var trimmed = lineData
            if trimmed.last == 0x0D { trimmed.removeLast() }

            let line = String(data: trimmed, encoding: .utf8) ?? ""
            handle(line: line)
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        if let error = error as NSError?, error.code != NSURLErrorCancelled {
            log.error("chat: stream error \(error.localizedDescription, privacy: .public)")
            continuation.finish(throwing: error)
        } else {
            log.debug("chat: stream finished, emitted=\(self.emittedCount) events")
            continuation.finish()
        }
        session.invalidateAndCancel()
    }

    private func handle(line: String) {
        if line.isEmpty {
            // Dispatch buffered event.
            let raw = pendingDataLines.joined(separator: "\n")
            if let parsed = decode(event: pendingEvent, raw: raw) {
                emittedCount += 1
                continuation.yield(parsed)
            } else if pendingEvent != nil {
                log.warning("SSE: dropped event=\(self.pendingEvent ?? "?", privacy: .public) data=\(raw, privacy: .public)")
            }
            pendingEvent = nil
            pendingDataLines.removeAll(keepingCapacity: true)
            return
        }
        if line.hasPrefix(":") { return } // comment line

        guard let colon = line.firstIndex(of: ":") else { return }
        let field = String(line[..<colon])
        var value = String(line[line.index(after: colon)...])
        if value.hasPrefix(" ") { value.removeFirst() }

        switch field {
        case "event": pendingEvent = value
        case "data":  pendingDataLines.append(value)
        default: break    // id:, retry: etc. — we don't use them
        }
    }

    private func decode(event: String?, raw: String) -> ChatEvent? {
        guard let event, let data = raw.data(using: .utf8) else { return nil }
        switch event {
        case "session":
            struct S: Decodable { let sessionId: String }
            return (try? decoder.decode(S.self, from: data))
                .map { .session(id: $0.sessionId) }
        case "status":
            struct S: Decodable { let state: String }
            return (try? decoder.decode(S.self, from: data))
                .map { .status(state: $0.state) }
        case "tool":
            return (try? decoder.decode(ChatToolEvent.self, from: data))
                .map { .tool($0) }
        case "token":
            struct T: Decodable { let text: String }
            return (try? decoder.decode(T.self, from: data))
                .map { .token(text: $0.text) }
        case "thinking":
            struct T: Decodable { let text: String }
            return (try? decoder.decode(T.self, from: data))
                .map { .thinking(text: $0.text) }
        case "done":
            return (try? decoder.decode(ChatDoneEvent.self, from: data))
                .map { .done($0) }
        case "error":
            struct E: Decodable { let message: String }
            return (try? decoder.decode(E.self, from: data))
                .map { .error(message: $0.message) }
        default:
            return nil
        }
    }
}

enum RuntimeError: LocalizedError {
    case notReachable
    case httpStatus(Int)

    var errorDescription: String? {
        switch self {
        case .notReachable:        return "Milo runtime daemon isn't reachable. Run `bun run server` in the project."
        case .httpStatus(let s):   return "Runtime returned HTTP \(s)."
        }
    }
}
