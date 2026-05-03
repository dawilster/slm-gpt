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
                // Pin content to the bottom — when the user manually drags
                // the panel taller, the empty space appears at the top and
                // the latest message stays right above the input row.
                .defaultScrollAnchor(.bottom)
                .onChange(of: state.chat.messages.count) { _, _ in
                    if let last = state.chat.messages.last {
                        withAnimation(.easeOut(duration: 0.2)) {
                            scroll.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }

            DockInputRow(
                placeholder: state.chat.messages.isEmpty ? "Ask Milo…" : "Reply or follow up…",
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

    /// Concrete starter prompts that map to the runtime's tool surface —
    /// each one will route through search_corpus / list_notes / get_current_time
    /// / remember etc. when the model decides what to call.
    private static let suggestions: [(icon: String, prompt: String)] = [
        ("clock",          "What time is it?"),
        ("note.text",      "Show me my recent notes"),
        ("brain",          "What do you remember about me?"),
        ("pencil.line",    "Help me draft a quick note"),
    ]

    private var emptyState: some View {
        VStack(spacing: 14) {
            Text("Ask anything — your conversations stay on this device.")
                .font(.haloUI(13))
                .foregroundStyle(Color.haloFgDim)
                .multilineTextAlignment(.center)

            FlowLayout(spacing: 6, alignment: .center) {
                ForEach(Self.suggestions, id: \.prompt) { suggestion in
                    SuggestionChip(
                        icon: suggestion.icon,
                        text: suggestion.prompt,
                        action: { state.chat.send(suggestion.prompt) }
                    )
                }
            }
            .padding(.horizontal, 12)

            if !runtimeStatus.connected {
                Text("Runtime daemon offline · run `bun run server`")
                    .font(.haloMono(10.5))
                    .foregroundStyle(Color.haloFgFaint)
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.top, 8)
    }
}

// MARK: - Suggestion chip

/// Compact capsule shown in the empty state. Click → sends the prompt.
private struct SuggestionChip: View {
    let icon: String
    let text: String
    let action: () -> Void

    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(Color.haloAccent)
                Text(text)
                    .font(.haloUI(12))
                    .foregroundStyle(Color.haloFg)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                Capsule().fill(Color.white.opacity(hovered ? 0.10 : 0.05))
            )
            .overlay(
                Capsule().stroke(Color.white.opacity(hovered ? 0.22 : 0.12), lineWidth: 0.5)
            )
            .animation(.easeOut(duration: 0.10), value: hovered)
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
    }
}

// MARK: - Flow layout (wraps capsules across rows)

/// Lightweight horizontal flow layout — fills each row left-to-right and
/// wraps to a new row when the next subview wouldn't fit. Used for the
/// suggestion chips so the prompts wrap naturally on narrow widths.
private struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    var alignment: HorizontalAlignment = .center

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var rows = layout(subviews: subviews, maxWidth: maxWidth)
        let height = rows.map(\.height).reduce(0, +)
            + CGFloat(max(0, rows.count - 1)) * spacing
        let width  = rows.map(\.width).max() ?? 0
        rows.removeAll()
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = layout(subviews: subviews, maxWidth: bounds.width)
        var y = bounds.minY
        for row in rows {
            let rowOriginX: CGFloat = {
                switch alignment {
                case .leading:  return bounds.minX
                case .trailing: return bounds.maxX - row.width
                default:        return bounds.minX + (bounds.width - row.width) / 2
                }
            }()
            var x = rowOriginX
            for item in row.items {
                subviews[item.index].place(
                    at: CGPoint(x: x, y: y),
                    proposal: ProposedViewSize(item.size)
                )
                x += item.size.width + spacing
            }
            y += row.height + spacing
        }
    }

    // MARK: helpers

    private struct Row { var items: [Item] = []; var width: CGFloat = 0; var height: CGFloat = 0 }
    private struct Item { let index: Int; let size: CGSize }

    private func layout(subviews: Subviews, maxWidth: CGFloat) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for (i, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            let next = current.width + (current.items.isEmpty ? 0 : spacing) + size.width
            if next > maxWidth, !current.items.isEmpty {
                rows.append(current)
                current = Row()
            }
            current.items.append(Item(index: i, size: size))
            current.width  = current.items.count == 1 ? size.width : current.width + spacing + size.width
            current.height = max(current.height, size.height)
        }
        if !current.items.isEmpty { rows.append(current) }
        return rows
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
                if !message.thinking.isEmpty {
                    ThinkingBlock(message: message)
                }

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
                    MessageMetaStrip(message: message)
                } else if message.isStreaming && message.toolCalls.isEmpty && message.thinking.isEmpty {
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

// MARK: - Per-message metadata strip (TTFT, total tokens, copy)

/// Quiet footer beneath an assistant reply. Surfaces:
///   – time-to-first-token (live, set on the first SSE token event)
///   – completion-token count + total latency once the turn lands
///   – copy-to-pasteboard button
private struct MessageMetaStrip: View {
    @Bindable var message: ChatMessage

    var body: some View {
        HStack(spacing: 12) {
            if let ttft = message.timeToFirstTokenMs {
                Label {
                    Text("\(ttft)ms")
                        .font(.haloMono(10.5))
                        .monospacedDigit()
                } icon: {
                    Image(systemName: "bolt.fill")
                        .font(.system(size: 9))
                }
                .foregroundStyle(Color.haloFgFaint)
                .help("Time to first token")
            }
            if let meta = message.meta {
                Label {
                    Text("\(meta.completionTokens) tok · \(meta.latencyMs)ms")
                        .font(.haloMono(10.5))
                        .monospacedDigit()
                } icon: {
                    Image(systemName: "tag")
                        .font(.system(size: 9))
                }
                .foregroundStyle(Color.haloFgFaint)
                .help("Completion tokens · total turn latency")
            }
            Spacer(minLength: 0)
            CopyButton(text: message.text)
        }
        .padding(.top, 2)
    }
}

private struct CopyButton: View {
    let text: String

    @State private var copied = false
    @State private var hovered = false

    var body: some View {
        Button(action: copy) {
            HStack(spacing: 4) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 10, weight: .medium))
                Text(copied ? "Copied" : "Copy")
                    .font(.haloUI(10.5))
            }
            .foregroundStyle(copied ? Color.haloGreen
                             : (hovered ? Color.haloFg : Color.haloFgFaint))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(Color.white.opacity(hovered ? 0.06 : 0))
                    .animation(.easeOut(duration: 0.10), value: hovered)
            )
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
    }

    private func copy() {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
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

// MARK: - Thinking-mode reasoning trace
//
// Collapsible block above the assistant reply. Header shows token count and
// status; body is dim/italic so it visually recedes vs the answer. Auto-
// expanded while reasoning is actively streaming, auto-collapsed once the
// answer text starts arriving (and stays collapsed in the archive view).
// Click the header to toggle manually.
private struct ThinkingBlock: View {
    @Bindable var message: ChatMessage
    @State private var manualOverride: Bool? = nil
    @State private var hovered = false

    /// Default expansion: true while we're still streaming reasoning AND no
    /// answer text has arrived yet. Once `message.text` is non-empty the
    /// answer is the focus, so collapse. User toggle wins via `manualOverride`.
    private var isExpanded: Bool {
        if let m = manualOverride { return m }
        if !message.isStreaming { return false }
        return message.text.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if isExpanded { body_ }
        }
        .background(Color.white.opacity(0.02))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 0.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var header: some View {
        Button(action: { manualOverride = !isExpanded }) {
            HStack(spacing: 8) {
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(Color.haloFgFaint)
                    .frame(width: 10)

                Text(headerLabel)
                    .font(.haloUI(11, weight: .medium))
                    .tracking(0.4)
                    .foregroundStyle(Color.haloFgDim)

                Spacer(minLength: 0)

                Text("\(message.thinking.count)c")
                    .font(.haloMono(10))
                    .foregroundStyle(Color.haloFgFaint)
                    .monospacedDigit()
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .contentShape(Rectangle())
            .background(Color.white.opacity(hovered ? 0.03 : 0))
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
    }

    /// "Thinking…" while still streaming reasoning, "Thought" once done.
    private var headerLabel: String {
        if message.isStreaming && message.text.isEmpty { return "Thinking…" }
        return "Thought"
    }

    private var body_: some View {
        Text(message.thinking)
            .font(.haloUI(12))
            .italic()
            .foregroundStyle(Color.haloFgDim)
            .lineSpacing(2)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12).padding(.bottom, 10).padding(.top, 2)
            .overlay(alignment: .top) {
                Rectangle().fill(Color.white.opacity(0.06)).frame(height: 0.5)
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
    /// Raw context window in tokens (e.g. 8192). Null when unknown.
    var contextLimit: Int? = nil
    /// Loaded model size in bytes — drives the size + RAM stats. Null when
    /// the runtime daemon couldn't probe `lms ps`. Displayed as "~N GB"
    /// since loaded RAM ≈ file size on Apple Silicon (unified memory) but
    /// isn't a precise live reading.
    var sizeBytes: Int64? = nil
    /// Rolling-average tok/s across recent turns. Null before the first turn.
    /// Displayed as "~N tok/s" — averaged, not instantaneous.
    var tokensPerSec: Double? = nil
    var quantization: String? = nil
    var paramsString: String? = nil

    static let offline = RuntimeStatus(connected: false, modelLabel: "(offline)", contextHint: nil)

    /// "~3.8" — averaged label, paired with unit "GB" in StatView. The "~"
    /// signals approximate / averaged across the model's lifetime. Nil → "—".
    var sizeNumber: String? {
        guard let b = sizeBytes, b > 0 else { return nil }
        return String(format: "~%.1f", Double(b) / 1_000_000_000)
    }

    /// "~3.8 GB" — full label with unit, for places that don't split number
    /// and unit (the model card's right-aligned size).
    var sizeLabel: String? {
        guard let n = sizeNumber else { return nil }
        return "\(n) GB"
    }

    /// "~42" — rolling-avg tok/s. Nil when the runtime has handled no turns.
    var tpsNumber: String? {
        guard let v = tokensPerSec, v > 0 else { return nil }
        return String(format: "~%.0f", v)
    }

    /// "8K" — context window rounded to nearest power-of-two thousand.
    var contextLabel: String? {
        guard let limit = contextLimit, limit > 0 else { return nil }
        if limit >= 1024 {
            let k = Double(limit) / 1024
            return k == k.rounded() ? "\(Int(k))K" : String(format: "%.1fK", k)
        }
        return "\(limit)"
    }
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
