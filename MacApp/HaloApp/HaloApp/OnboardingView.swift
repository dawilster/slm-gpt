import SwiftUI

/// Shown on first launch — pick the summon hotkey.
/// Wraps the same dock-shell aesthetic so the visual language is unified.
struct OnboardingView: View {
    var onContinue: () -> Void = {}
    var onTryNow: () -> Void = {}
    var onClose: () -> Void = {}

    private struct Step { let label: String; let state: State
        enum State { case done, active, todo }
    }
    private let steps: [Step] = [
        .init(label: "Choose a model", state: .done),
        .init(label: "Set your hotkey", state: .active),
        .init(label: "Grant permissions", state: .todo),
    ]

    var body: some View {
        DockShell {
            VStack(alignment: .leading, spacing: 0) {
                stepIndicator
                    .padding(.bottom, 16)

                HStack(alignment: .top, spacing: 22) {
                    HaloOrb(size: 56, state: .idle).padding(.top, 4)
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Pick how you summon Milo.")
                            .font(.haloUI(22, weight: .semibold))
                            .tracking(-0.44)
                            .padding(.bottom, 8)
                        Text("A single keystroke from anywhere. Whisper-quiet, instant, never leaves your Mac.")
                            .font(.haloUI(13))
                            .foregroundStyle(Color.haloFgDim)
                            .lineSpacing(3)
                            .frame(maxWidth: 440, alignment: .leading)
                            .padding(.bottom, 18)

                        hotkeyPicker
                            .padding(.bottom, 18)

                        HStack(spacing: 8) {
                            Button(action: onContinue) { Text("Continue") }
                                .buttonStyle(HaloButtonStyle(variant: .primary))
                            Button(action: onTryNow) { Text("Try it now") }
                                .buttonStyle(HaloButtonStyle())
                        }
                    }
                }
            }
            .padding(.horizontal, 32).padding(.top, 30).padding(.bottom, 26)
        }
        .overlay(alignment: .topLeading) {
            WindowCloseButton(action: onClose)
                .padding(14)
        }
        .onKeyPress(.escape) {
            onClose()
            return .handled
        }
    }

    private var stepIndicator: some View {
        HStack(spacing: 8) {
            ForEach(Array(steps.enumerated()), id: \.offset) { i, s in
                Text(String(format: "%02d %@", i + 1, s.label))
                    .font(.haloUI(10.5, weight: s.state == .active ? .semibold : .regular))
                    .tracking(0.8)
                    .textCase(.uppercase)
                    .foregroundStyle(stepColor(s.state))
                if i < steps.count - 1 {
                    Rectangle()
                        .fill(Color.white.opacity(0.10))
                        .frame(width: 18, height: 0.5)
                }
            }
        }
    }

    private func stepColor(_ s: Step.State) -> Color {
        switch s {
        case .active: return Color.haloAccent
        case .done:   return Color.haloFgDim
        case .todo:   return Color.haloFgFaint
        }
    }

    private var hotkeyPicker: some View {
        HotkeyRecorderView(fullChrome: true)
            .frame(maxWidth: 380, alignment: .leading)
    }
}
