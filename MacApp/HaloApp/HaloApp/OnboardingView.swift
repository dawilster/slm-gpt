import SwiftUI

/// Multi-step onboarding. Two real steps right now: pick how Milo gets
/// its model (endpoint), then bind the summon hotkey. The model-catalog
/// download itself isn't part of onboarding until v8.5 ships built-in
/// inference — until then, "use my own endpoint" is the functional path
/// and "bundled" is a teaser/pre-download option.
struct OnboardingView: View {
    var onContinue: () -> Void = {}
    var onTryNow: () -> Void = {}
    var onClose: () -> Void = {}

    @Environment(AppState.self) private var state

    enum Step: Int, CaseIterable {
        case endpoint, hotkey
        var label: String {
            switch self {
            case .endpoint: return "Choose endpoint"
            case .hotkey:   return "Set your hotkey"
            }
        }
    }

    @State private var step: Step = .endpoint

    var body: some View {
        DockShell {
            VStack(alignment: .leading, spacing: 0) {
                stepIndicator
                    .padding(.bottom, 16)

                HStack(alignment: .top, spacing: 22) {
                    HaloOrb(size: 56, state: .idle).padding(.top, 4)
                    VStack(alignment: .leading, spacing: 0) {
                        switch step {
                        case .endpoint: endpointStep
                        case .hotkey:   hotkeyStep
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

    // MARK: - Step 1 — endpoint

    @ViewBuilder
    private var endpointStep: some View {
        @Bindable var state = state
        Text("Where should Milo get its brain?")
            .font(.haloUI(22, weight: .semibold))
            .tracking(-0.44)
            .padding(.bottom, 8)
        Text("Milo needs a small language model to think with. You can pre-pick a vetted one for when built-in inference ships, or point at a model you already run yourself.")
            .font(.haloUI(13))
            .foregroundStyle(Color.haloFgDim)
            .lineSpacing(3)
            .frame(maxWidth: 480, alignment: .leading)
            .padding(.bottom, 18)

        VStack(spacing: 10) {
            EndpointChoiceCard(
                title: "Bundled model",
                badge: "Preview · v8.5",
                subtitle: "We'll ship a vetted SLM with the next release. Pick from the catalog in Settings to pre-download.",
                selected: state.endpointMode == .bundled,
                onTap: { state.endpointMode = .bundled }
            )
            EndpointChoiceCard(
                title: "I have my own endpoint",
                badge: "Available now",
                subtitle: "OpenAI-compatible server like LM Studio, Ollama, or mlx_lm.server.",
                selected: state.endpointMode == .external,
                onTap: { state.endpointMode = .external },
                detail: state.endpointMode == .external ? AnyView(externalURLField(state: state)) : nil
            )
        }
        .padding(.bottom, 18)

        HStack(spacing: 8) {
            Button(action: { step = .hotkey }) { Text("Continue") }
                .buttonStyle(HaloButtonStyle(variant: .primary))
            Button(action: onTryNow) { Text("Skip — try it now") }
                .buttonStyle(HaloButtonStyle())
        }
    }

    @ViewBuilder
    private func externalURLField(state: AppState) -> some View {
        @Bindable var state = state
        HStack(spacing: 8) {
            TextField("http://localhost:1234/v1", text: $state.externalEndpointURL)
                .textFieldStyle(.plain)
                .font(.haloMono(11.5))
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(Color.black.opacity(0.20))
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(Color.white.opacity(0.10), lineWidth: 0.5)
                )
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .padding(.top, 8)
    }

    // MARK: - Step 2 — hotkey

    @ViewBuilder
    private var hotkeyStep: some View {
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

        HotkeyRecorderView(fullChrome: true)
            .frame(maxWidth: 380, alignment: .leading)
            .padding(.bottom, 18)

        HStack(spacing: 8) {
            Button(action: { step = .endpoint }) { Text("Back") }
                .buttonStyle(HaloButtonStyle())
            Button(action: onContinue) { Text("Finish") }
                .buttonStyle(HaloButtonStyle(variant: .primary))
        }
    }

    // MARK: - Step indicator

    private var stepIndicator: some View {
        HStack(spacing: 8) {
            ForEach(Array(Step.allCases.enumerated()), id: \.offset) { i, s in
                Text(String(format: "%02d %@", i + 1, s.label))
                    .font(.haloUI(10.5, weight: s == step ? .semibold : .regular))
                    .tracking(0.8)
                    .textCase(.uppercase)
                    .foregroundStyle(stepColor(for: s))
                if i < Step.allCases.count - 1 {
                    Rectangle()
                        .fill(Color.white.opacity(0.10))
                        .frame(width: 18, height: 0.5)
                }
            }
        }
    }

    private func stepColor(for s: Step) -> Color {
        if s == step { return Color.haloAccent }
        if s.rawValue < step.rawValue { return Color.haloFgDim }
        return Color.haloFgFaint
    }
}

// MARK: - Choice card (endpoint picker)

private struct EndpointChoiceCard: View {
    let title: String
    let badge: String
    let subtitle: String
    let selected: Bool
    let onTap: () -> Void
    var detail: AnyView? = nil

    @State private var hovered = false

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    selectedIndicator
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Text(title).font(.haloUI(13, weight: .medium))
                            Text(badge.uppercased())
                                .font(.haloUI(9, weight: .semibold))
                                .tracking(0.6)
                                .foregroundStyle(badgeColor)
                                .padding(.horizontal, 5).padding(.vertical, 2)
                                .background(badgeColor.opacity(0.15))
                                .clipShape(Capsule())
                        }
                        Text(subtitle)
                            .font(.haloUI(11.5))
                            .foregroundStyle(Color.haloFgDim)
                            .lineSpacing(2)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: 380, alignment: .leading)
                    }
                    Spacer(minLength: 0)
                }
                if let detail {
                    detail
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(selected ? Color.haloAccent.opacity(0.08)
                          : (hovered ? Color.white.opacity(0.04) : Color.white.opacity(0.02)))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(selected ? Color.haloAccent.opacity(0.55)
                            : Color.white.opacity(0.10), lineWidth: selected ? 1.0 : 0.5)
            )
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
    }

    private var badgeColor: Color {
        if badge.contains("Preview") { return Color.haloWarn }
        return Color.haloGreen
    }

    private var selectedIndicator: some View {
        ZStack {
            Circle().stroke(Color.white.opacity(selected ? 0.55 : 0.18), lineWidth: 1)
            if selected {
                Circle().fill(Color.haloAccent).padding(3)
            }
        }
        .frame(width: 14, height: 14)
        .padding(.top, 2)
    }
}
