import SwiftUI

/// Unified dock chat surface — same view for idle/thinking/streaming.
/// Renders the live `ChatSession` from AppState and submits new turns.
struct DockChatView: View {
    @Environment(AppState.self) private var state
    @Environment(\.runtimeStatus) private var runtimeStatus

    var body: some View {
        DockShell {
            statusStrip

            ScrollViewReader { scroll in
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if state.chat.messages.isEmpty {
                            emptyState
                        } else {
                            ForEach(state.chat.messages) { message in
                                MessageRow(message: message).id(message.id)
                            }
                        }
                    }
                    .padding(.horizontal, 22)
                    .padding(.top, 18).padding(.bottom, 14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                // No fixed maxHeight — the SwiftUI content sizes itself
                // naturally, the surrounding NSPanel grows to match
                // (capped at 75% of the screen by DockWindowController).
                .onChange(of: state.chat.messages.count) { _, _ in
                    if let last = state.chat.messages.last {
                        withAnimation(.easeOut(duration: 0.2)) {
                            scroll.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }

            DockInputRow(
                placeholder: state.chat.messages.isEmpty ? "Ask Halo…" : "Reply or follow up…",
                showHints: state.chat.messages.isEmpty,
                disabled: state.chat.status == .thinking,
                onSubmit: { text in state.chat.send(text) }
            )
        }
    }

    // MARK: - Status strip

    @ViewBuilder
    private var statusStrip: some View {
        switch state.chat.status {
        case .thinking:
            DockStatusStrip(mode: .thinking(stepHint: meta(suffix: "generating")))
        case .error(let msg):
            errorStrip(msg)
        case .ready:
            readyStrip
        }
    }

    private var readyStrip: some View {
        HStack(spacing: 10) {
            StatusDot(color: runtimeStatus.connected ? Color.haloAccent : Color.haloFgFaint)
            Text(runtimeStatus.connected ? "Ready" : "Offline")
                .foregroundStyle(Color.haloFg)
            VRule()
            Text(runtimeStatus.modelLabel)
                .font(.haloMono(11)).foregroundStyle(Color.haloFgDim)
            if let ctx = runtimeStatus.contextHint {
                Text("· \(ctx)")
                    .font(.haloMono(10.5)).foregroundStyle(Color.haloFgFaint)
            }
            Spacer(minLength: 0)
            PrivacyPill()
        }
        .font(.haloUI(11))
        .padding(.horizontal, 16)
        .padding(.top, 10).padding(.bottom, 8)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.white.opacity(0.05)).frame(height: 0.5)
        }
    }

    private func errorStrip(_ msg: String) -> some View {
        HStack(spacing: 10) {
            StatusDot(color: Color(red: 0.92, green: 0.43, blue: 0.40))
            Text("Runtime error").foregroundStyle(Color.haloFg)
            VRule()
            Text(msg)
                .font(.haloMono(10.5))
                .foregroundStyle(Color.haloFgFaint)
                .lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .font(.haloUI(11))
        .padding(.horizontal, 16)
        .padding(.top, 10).padding(.bottom, 8)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.white.opacity(0.05)).frame(height: 0.5)
        }
    }

    private func meta(suffix: String) -> String {
        guard let m = state.chat.lastTurnMeta else { return "· \(suffix)" }
        return "· \(suffix) · \(m.completionTokens)t"
    }

    // MARK: - Empty placeholder

    private var emptyState: some View {
        VStack(spacing: 6) {
            Text("Ask anything — your conversations stay on this device.")
                .font(.haloUI(13))
                .foregroundStyle(Color.haloFgDim)
                .multilineTextAlignment(.center)
            if !runtimeStatus.connected {
                Text("Runtime daemon offline · run `bun run server`")
                    .font(.haloMono(10.5))
                    .foregroundStyle(Color.haloFgFaint)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 60)
    }
}

// MARK: - Message bubble

private struct MessageRow: View {
    let message: ChatMessage

    var body: some View {
        if message.role == .user {
            HStack { Spacer()
                Text(message.text)
                    .font(.haloUI(14))
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(Color.white.opacity(0.08))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(Color.white.opacity(0.10), lineWidth: 0.5)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .frame(maxWidth: 0.85 * HaloMetrics.dockWidth, alignment: .trailing)
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                if !message.toolCalls.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(message.toolCalls) { trace in
                            ToolCallRow(trace: trace,
                                        isLast: trace.id == message.toolCalls.last?.id)
                        }
                    }
                    .background(Color.white.opacity(0.02))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(Color.white.opacity(0.08), lineWidth: 0.5)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }

                if !message.text.isEmpty {
                    replyText
                } else if message.isStreaming && message.toolCalls.isEmpty {
                    ThinkingIndicator()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private var replyText: some View {
        MarkdownText(text: message.text, isStreaming: message.isStreaming)
            .textSelection(.enabled)
    }
}

// MARK: - Animated thinking indicator (cycling dots)

/// "Thinking" with three dots fading in 0 → 3 → 0 every ~1.6s.
/// Each dot is always laid out so the indicator's width never shifts.
private struct ThinkingIndicator: View {
    private static let step: TimeInterval = 0.4

    var body: some View {
        TimelineView(.periodic(from: .now, by: Self.step)) { context in
            let phase = Int(context.date.timeIntervalSinceReferenceDate / Self.step) % 4
            HStack(spacing: 1) {
                Text("Thinking")
                ForEach(0..<3, id: \.self) { i in
                    Text(".").opacity(i < phase ? 1.0 : 0.20)
                }
            }
            .font(.haloUI(15))
            .foregroundStyle(Color.haloFgFaint)
        }
    }
}

// MARK: - Tool call inline row

private struct ToolCallRow: View {
    let trace: ToolCallTrace
    let isLast: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            statusPuck

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(trace.name.uppercased())
                        .font(.haloMono(10))
                        .tracking(0.8)
                        .foregroundStyle(trace.isError ? Color.haloRunning : Color.haloFgFaint)
                    Text("\(trace.latencyMs)ms")
                        .font(.haloMono(10))
                        .foregroundStyle(Color.haloFgFaint)
                }
                Text(trace.result)
                    .font(.haloUI(12.5))
                    .foregroundStyle(trace.isError ? Color.haloRunning : Color.haloFgDim)
                    .lineLimit(3)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .overlay(alignment: .bottom) {
            if !isLast {
                Rectangle().fill(Color.white.opacity(0.06)).frame(height: 0.5)
            }
        }
    }

    @ViewBuilder
    private var statusPuck: some View {
        ZStack {
            Circle()
                .fill(trace.isError ? Color(red: 0.92, green: 0.43, blue: 0.40) : Color.haloGreen)
                .frame(width: 18, height: 18)
            Text(trace.isError ? "!" : "✓")
                .font(.haloUI(10, weight: .bold))
                .foregroundStyle(Color(red: 0.05, green: 0.18, blue: 0.10))
        }
        .padding(.top, 1)
    }
}

// MARK: - Runtime status injection (probed health → environment)

struct RuntimeStatus: Equatable {
    var connected: Bool
    var modelLabel: String
    var contextHint: String?

    static let offline = RuntimeStatus(connected: false, modelLabel: "(offline)", contextHint: nil)
}

private struct RuntimeStatusKey: EnvironmentKey {
    static let defaultValue: RuntimeStatus = .offline
}

extension EnvironmentValues {
    var runtimeStatus: RuntimeStatus {
        get { self[RuntimeStatusKey.self] }
        set { self[RuntimeStatusKey.self] = newValue }
    }
}
