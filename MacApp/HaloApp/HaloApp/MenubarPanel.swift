import SwiftUI

/// The dropdown panel that appears when the menubar icon is clicked.
/// Hero status block + model card + recents + footer (Settings · History · Pause).
struct MenubarPanelView: View {
    @Environment(AppState.self) private var state
    var onSummon: () -> Void = {}
    var onSettings: () -> Void = {}
    var onRunSetup: () -> Void = {}
    var onCycleDock: () -> Void = {}

    private struct Recent: Identifiable {
        let id = UUID()
        let title: String
        let time: String
    }

    private let recents: [Recent] = [
        .init(title: "Refactor the auth middleware", time: "2m"),
        .init(title: "Summarize meeting notes from yesterday", time: "1h"),
        .init(title: "Why is my SwiftUI list reloading?", time: "3h"),
        .init(title: "Draft an email to the design team", time: "Yesterday"),
    ]

    @State private var paused = false
    @State private var summonHovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            heroBlock
            Hairline()
            recentsBlock
            Hairline()
            footer
        }
        .frame(width: HaloMetrics.panelWidth)
        .foregroundStyle(Color.haloFg)
        .contextMenu {
            Button("Summon dock") { onSummon() }
            Button("Cycle dock state") { onCycleDock() }
            Divider()
            Button("Run setup again") { onRunSetup() }
        }
    }

    // MARK: - Hero (status + model card)

    private var heroBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                HaloOrb(size: 26, state: state.menubarState)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Halo")
                        .font(.haloUI(13, weight: .semibold))
                        .tracking(-0.13)
                    Text("Ready · Local")
                        .font(.haloUI(11))
                        .foregroundStyle(Color.haloFgDim)
                }
                Spacer(minLength: 0)
                Button(action: onSummon) {
                    HStack(spacing: 4) {
                        Text("Summon").font(.haloUI(11, weight: .medium))
                        Text(state.hotkey.displayString)
                            .font(.haloMono(10))
                            .foregroundStyle(Color.haloFgFaint)
                    }
                    .foregroundStyle(Color.haloFg)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Color.white.opacity(summonHovered ? 0.12 : 0.06))
                    .overlay(
                        Capsule().stroke(
                            Color.white.opacity(summonHovered ? 0.22 : 0.14),
                            lineWidth: 0.5)
                    )
                    .clipShape(Capsule())
                    .animation(.easeOut(duration: 0.10), value: summonHovered)
                }
                .buttonStyle(.plain)
                .onHover { summonHovered = $0 }
            }

            // Model card
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Text("llama-3.3-8b-q4")
                        .font(.haloMono(11.5))
                        .foregroundStyle(Color.haloFg)
                    Spacer(minLength: 0)
                    Text("4.6 GB")
                        .font(.haloMono(10.5))
                        .foregroundStyle(Color.haloFgFaint)
                        .monospacedDigit()
                }
                HStack(alignment: .top, spacing: 12) {
                    StatView(label: "RAM", value: "3.8", unit: "GB")
                    StatView(label: "Speed", value: "42", unit: "tok/s")
                    StatView(label: "Context", value: "8K", unit: "")
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Color.white.opacity(0.04))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Color.white.opacity(0.08), lineWidth: 0.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 12)
    }

    // MARK: - Recents list

    private var recentsBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("RECENT")
                .font(.haloUI(10, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(Color.haloFgFaint)
                .padding(.bottom, 0)

            VStack(spacing: 0) {
                ForEach(Array(recents.enumerated()), id: \.element.id) { i, r in
                    RecentRow(
                        title: r.title,
                        time: r.time,
                        accent: i == 0,
                        action: onSummon // STUB: load this conversation
                    )
                }
            }
        }
        .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 8)
    }

    // MARK: - Footer (Settings · History + Pause)

    private var footer: some View {
        HStack {
            FooterLink(text: "Settings", action: onSettings)
            FooterLink(text: "History", action: { /* STUB: open history */ })
                .padding(.leading, 6)

            Spacer()

            Text("Pause")
                .font(.haloUI(11))
                .foregroundStyle(Color.haloFgFaint)
            ToggleSwitch(isOn: $paused)
        }
        .font(.haloUI(12.5))
        .foregroundStyle(Color.haloFgDim)
        .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 12)
    }
}

/// A row in the recents list — accent dot, title, time, with hover.
private struct RecentRow: View {
    let title: String
    let time: String
    let accent: Bool
    let action: () -> Void

    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Circle()
                    .fill(accent ? Color.haloAccent : Color.haloFgFaint)
                    .frame(width: 4, height: 4)
                Text(title)
                    .font(.haloUI(12.5))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .foregroundStyle(Color.haloFg)
                Spacer(minLength: 0)
                Text(time)
                    .font(.haloMono(10.5))
                    .foregroundStyle(Color.haloFgFaint)
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(rowBackground)
                    .animation(.easeOut(duration: 0.10), value: hovered)
            )
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .onHover { hovered = $0 }
    }

    private var rowBackground: Color {
        if hovered { return Color.white.opacity(0.10) }
        if accent  { return Color.white.opacity(0.04) }
        return .clear
    }
}

/// Footer link with hover underline.
private struct FooterLink: View {
    let text: String
    let action: () -> Void

    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            Text(text)
                .foregroundStyle(hovered ? Color.haloFg : Color.haloFgDim)
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color.white.opacity(hovered ? 0.06 : 0))
                        .animation(.easeOut(duration: 0.10), value: hovered)
                )
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
    }
}

/// A compact pill-shaped toggle matching the menubar dropdown design.
struct ToggleSwitch: View {
    @Binding var isOn: Bool
    @State private var hovered = false

    var body: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.15)) { isOn.toggle() }
        } label: {
            ZStack(alignment: isOn ? .trailing : .leading) {
                Capsule()
                    .fill(isOn ? Color.haloAccent : Color.white.opacity(hovered ? 0.18 : 0.12))
                    .frame(width: 28, height: 16)
                    .overlay(Capsule().stroke(Color.white.opacity(0.20), lineWidth: 0.5))
                Circle()
                    .fill(.white)
                    .frame(width: 13, height: 13)
                    .padding(.horizontal, 1.5)
                    .shadow(color: .black.opacity(0.3), radius: 1, x: 0, y: 1)
            }
            .animation(.easeOut(duration: 0.10), value: hovered)
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
    }
}
