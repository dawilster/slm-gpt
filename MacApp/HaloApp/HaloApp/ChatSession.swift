import SwiftUI
import os

private let chatLog = Logger(subsystem: "halo.runtime", category: "chat")

// MARK: - In-memory conversation state shared across dock summons.

enum ChatRole: String, Sendable {
    case user, assistant
}

@Observable
final class ChatMessage: Identifiable {
    let id = UUID()
    let role: ChatRole
    var text: String
    /// Tool-call rows the assistant emitted while producing this message
    /// (one per executed tool — populated as `tool` events arrive over SSE).
    var toolCalls: [ToolCallTrace]
    /// True while the assistant is still streaming this turn.
    var isStreaming: Bool
    /// Final-turn metadata; nil while streaming.
    var meta: TurnMeta?
    /// Milliseconds from request-send to first token rendered. Set the
    /// instant the first SSE `token` event arrives; nil for messages that
    /// only emitted tool calls or that came from a saved session.
    var timeToFirstTokenMs: Int?

    init(role: ChatRole, text: String = "", isStreaming: Bool = false) {
        self.role = role
        self.text = text
        self.toolCalls = []
        self.isStreaming = isStreaming
    }
}

struct ToolCallTrace: Identifiable, Sendable {
    let id = UUID()
    let step: Int
    let name: String
    let result: String
    let latencyMs: Int
    let isError: Bool
}

struct TurnMeta: Sendable {
    let promptTokens: Int
    let completionTokens: Int
    let latencyMs: Int
    let steps: Int
    let toolCallsExecuted: Int
}

enum ChatStatus: Equatable {
    case ready
    case thinking
    case error(String)
}

// MARK: - The chat itself

@Observable
final class ChatSession {
    /// How long the dock can sit dismissed before the next summon starts a
    /// fresh conversation instead of reopening the previous one.
    static let idleResetWindow: TimeInterval = 60

    /// Server-assigned session id (echoed via the first SSE `session` event).
    /// Persists for the life of this conversation; `newConversation()` clears it.
    var sessionId: String?

    var messages: [ChatMessage] = []
    var status: ChatStatus = .ready

    /// Cancel handle for the in-flight request — `Esc` aborts via this.
    private var inFlight: Task<Void, Never>?

    /// Most recent done-event metadata, for the status strip.
    var lastTurnMeta: TurnMeta?

    /// Tracks when the user last either sent something or summoned the dock,
    /// so we can decide whether a re-summon should start fresh or continue.
    private var lastInteractionAt: Date = .distantPast

    func newConversation() {
        cancel()
        sessionId = nil
        messages.removeAll()
        status = .ready
        lastTurnMeta = nil
        lastInteractionAt = Date()
    }

    /// Called when the dock is summoned. If the conversation has been idle
    /// for `idleResetWindow`, start a clean chat — keeps long-forgotten
    /// conversations from polluting context when the user comes back later.
    func markSummoned() {
        let now = Date()
        if !messages.isEmpty,
           now.timeIntervalSince(lastInteractionAt) > Self.idleResetWindow {
            chatLog.debug("idle reset (>\(Self.idleResetWindow, privacy: .public)s) — starting new chat")
            newConversation()
        }
        lastInteractionAt = now
    }

    /// Replace the current conversation with one loaded from the daemon.
    func load(_ detail: SessionDetailResponse) {
        cancel()
        sessionId = detail.id
        messages = detail.messages.map {
            let role: ChatRole = $0.role == "user" ? .user : .assistant
            return ChatMessage(role: role, text: $0.text, isStreaming: false)
        }
        status = .ready
        lastTurnMeta = nil
        lastInteractionAt = Date()
    }

    func cancel() {
        inFlight?.cancel()
        inFlight = nil
        if case .thinking = status {
            status = .ready
            // If we cancelled mid-stream, keep what we have but mark not-streaming.
            if let last = messages.last, last.role == .assistant, last.isStreaming {
                last.isStreaming = false
            }
        }
    }

    /// Submit a user message. Appends locally, opens an SSE stream, folds
    /// events into the assistant's reply as they arrive.
    func send(_ text: String, runtime: RuntimeClient = .shared) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        cancel()
        lastInteractionAt = Date()

        let userMsg = ChatMessage(role: .user, text: trimmed)
        let asstMsg = ChatMessage(role: .assistant, text: "", isStreaming: true)
        messages.append(userMsg)
        messages.append(asstMsg)
        status = .thinking

        let sid = sessionId
        let startedAt = Date()
        inFlight = Task { [weak self] in
            guard let self else { return }
            do {
                for try await event in runtime.chat(message: trimmed, sessionId: sid) {
                    if Task.isCancelled { break }
                    await MainActor.run { self.handle(event, into: asstMsg, startedAt: startedAt) }
                }
                await MainActor.run {
                    asstMsg.isStreaming = false
                    if case .thinking = self.status { self.status = .ready }
                }
            } catch {
                await MainActor.run {
                    asstMsg.isStreaming = false
                    asstMsg.text = asstMsg.text.isEmpty
                        ? "Couldn't reach the runtime daemon. Run `bun run server` in the project root."
                        : asstMsg.text
                    self.status = .error(error.localizedDescription)
                }
            }
        }
    }

    @MainActor
    private func handle(_ event: ChatEvent, into asstMsg: ChatMessage, startedAt: Date) {
        switch event {
        case .session(let id):
            chatLog.debug("evt session: \(id, privacy: .public)")
            sessionId = id
        case .status(let s):
            chatLog.debug("evt status: \(s, privacy: .public)")
        case .tool(let tool):
            chatLog.debug("evt tool: \(tool.name, privacy: .public)")
            asstMsg.toolCalls.append(ToolCallTrace(
                step: tool.step, name: tool.name, result: tool.result,
                latencyMs: tool.latencyMs, isError: tool.isError
            ))
        case .token(let text):
            chatLog.debug("evt token: \(text.count) chars")
            if asstMsg.timeToFirstTokenMs == nil {
                asstMsg.timeToFirstTokenMs = Int(Date().timeIntervalSince(startedAt) * 1000)
            }
            asstMsg.text.append(text)
        case .done(let done):
            chatLog.debug("evt done: \(done.completionTokens) tok, \(done.latencyMs)ms")
            let meta = TurnMeta(
                promptTokens: done.promptTokens,
                completionTokens: done.completionTokens,
                latencyMs: done.latencyMs,
                steps: done.steps,
                toolCallsExecuted: done.toolCallsExecuted
            )
            asstMsg.meta = meta
            asstMsg.isStreaming = false
            lastTurnMeta = meta
            sessionId = done.sessionId

            // If the user dismissed the dock while we were generating,
            // surface the reply as a banner so they don't miss it.
            let dockVisible = AppDelegate.shared?.isDockVisible ?? false
            chatLog.debug("done: dockVisible=\(dockVisible), replyChars=\(asstMsg.text.count)")
            if !dockVisible, !asstMsg.text.isEmpty {
                Notifier.shared.postReply(asstMsg.text)
            }
        case .error(let msg):
            chatLog.error("evt error: \(msg, privacy: .public)")
            asstMsg.isStreaming = false
            status = .error(msg)
        }
    }
}
