import SwiftUI
import AppKit

// MARK: - DockShell — shared chrome (status strip + body + input row)

struct DockShell<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            content()
        }
        .frame(width: HaloMetrics.dockWidth)
        .background(
            VisualEffectBackground(material: .hudWindow, blendingMode: .behindWindow)
                .overlay(Color.haloBgDeep.opacity(0.30))
        )
        .clipShape(RoundedRectangle(cornerRadius: HaloMetrics.dockCornerRadius, style: .continuous))
        .shadow(color: .black.opacity(0.55), radius: 40, x: 0, y: 24)
        .foregroundStyle(Color.haloFg)
    }
}

// MARK: - Status strip — top-of-dock thin row showing readiness + (subtle) model

struct DockStatusStrip: View {
    enum Mode {
        case ready
        case thinking(stepHint: String?)
        case shortcut(step: Int, of: Int)
    }
    var mode: Mode

    var body: some View {
        HStack(spacing: 10) {
            switch mode {
            case .ready:
                StatusDot(color: .haloAccent)
                Text("Ready").foregroundStyle(Color.haloFg)
                VRule()
                Text("llama-3.3-8b-q4")
                    .font(.haloMono(11)).foregroundStyle(Color.haloFgDim)
                Text("· 8K ctx · 42 tok/s")
                    .font(.haloMono(10.5)).foregroundStyle(Color.haloFgFaint)
                Spacer(minLength: 0)
                PrivacyPill()

            case .thinking(let hint):
                StatusDot(color: .haloRunning)
                Text("Thinking").foregroundStyle(Color.haloFg)
                VRule()
                Text("llama-3.3-8b-q4")
                    .font(.haloMono(11)).foregroundStyle(Color.haloFgDim)
                Text(hint ?? "· generating · 38 tok/s")
                    .font(.haloMono(10.5)).foregroundStyle(Color.haloFgFaint)
                Spacer(minLength: 0)
                Text("esc to stop")
                    .font(.haloMono(10.5)).foregroundStyle(Color.haloFgFaint)

            case .shortcut(let step, let total):
                StatusDot(color: .haloRunning)
                Text("Running shortcut").foregroundStyle(Color.haloFg).fontWeight(.medium)
                Text("· step \(step) of \(total)")
                    .font(.haloUI(11)).foregroundStyle(Color.haloFg.opacity(0.45))
                Spacer(minLength: 0)
                Text("esc to stop")
                    .font(.haloMono(10.5)).foregroundStyle(Color.haloFg.opacity(0.55))
            }
        }
        .font(.haloUI(11))
        .foregroundStyle(Color.haloFgDim)
        .padding(.horizontal, 16)
        .padding(.top, 10).padding(.bottom, 8)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.white.opacity(0.05)).frame(height: 0.5)
        }
    }
}

// MARK: - Input row — small orb + text field (or placeholder) + ⌘K hint + ↵

struct DockInputRow: View {
    var placeholder: String = "Ask Milo…"
    var showHints: Bool = false
    var disabled: Bool = false
    var onSubmit: (String) -> Void = { _ in }

    @State private var text: String = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // Mini orb
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            Color(red: 0.85, green: 0.85, blue: 0.99),
                            Color(red: 0.55, green: 0.55, blue: 0.92),
                            Color(red: 0.30, green: 0.25, blue: 0.55),
                        ],
                        center: UnitPoint(x: 0.30, y: 0.30),
                        startRadius: 0, endRadius: 14
                    )
                )
                .overlay(Circle().stroke(Color.white.opacity(0.25), lineWidth: 0.5))
                .shadow(color: Color.haloAccent.opacity(0.50), radius: 10)
                .frame(width: 28, height: 28)

            TextField("", text: $text, prompt:
                Text(placeholder).foregroundStyle(Color.haloFgFaint),
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .lineLimit(1...8)
            .font(.haloUI(15))
            .foregroundStyle(Color.haloFg)
            .focused($focused)
            .disabled(disabled)
            .opacity(disabled ? 0.4 : 1)
            // Chat-style submit: Return sends, Shift+Return inserts a newline.
            // axis: .vertical otherwise treats Return as a literal newline,
            // so we intercept here before TextField handles the keystroke.
            .onKeyPress(.return, phases: .down) { keyPress in
                if keyPress.modifiers.contains(.shift) { return .ignored }
                submit()
                return .handled
            }
            .padding(.top, 5)

            if showHints {
                HStack(spacing: 6) {
                    InlineKey(text: "⌘K")
                    Text("commands")
                        .font(.haloMono(10.5))
                        .foregroundStyle(Color.haloFgFaint)
                }
                .padding(.top, 7)
            }
            InlineKey(text: "↵").padding(.top, 7)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .overlay(alignment: .top) {
            Rectangle().fill(Color.white.opacity(0.06)).frame(height: 0.5)
        }
        .onAppear {
            if !disabled { focused = true }
        }
        // Re-focus on every summon — the SwiftUI view may already exist when
        // the dock is shown again, so .onAppear alone won't fire.
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { note in
            guard !disabled, note.object is HaloDockPanel else { return }
            focused = true
        }
    }

    private func submit() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        onSubmit(trimmed)
        text = ""
    }
}
