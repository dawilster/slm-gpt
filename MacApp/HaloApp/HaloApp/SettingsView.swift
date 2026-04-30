import SwiftUI

/// Two-pane settings window: sidebar nav + content.
struct SettingsView: View {
    @State private var selected: SettingsSection = .model

    var body: some View {
        DockShell {
            VStack(spacing: 0) {
                header
                HStack(spacing: 0) {
                    sidebar
                    Rectangle().fill(Color.white.opacity(0.06)).frame(width: 0.5)
                    content.frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(minHeight: 380)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            HaloOrb(size: 20, state: .idle)
            Text("Settings").font(.haloUI(13, weight: .semibold))
            Spacer(minLength: 0)
            Text("v1.0.4")
                .font(.haloMono(10.5))
                .foregroundStyle(Color.haloFgFaint)
        }
        .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 10)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.white.opacity(0.06)).frame(height: 0.5)
        }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(SettingsSection.allCases) { row in
                SidebarRow(
                    label: row.label,
                    selected: selected == row,
                    action: { selected = row }
                )
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8).padding(.vertical, 12)
        .frame(width: 150)
    }

    @ViewBuilder
    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch selected {
            case .model:  modelPane
            case .hotkey: hotkeyPane
            default:
                Text(selected.label)
                    .font(.haloUI(13, weight: .medium))
                    .foregroundStyle(Color.haloFgDim)
                    .padding(20)
                Spacer()
            }
        }
        .padding(.horizontal, 20).padding(.top, 14).padding(.bottom, 20)
    }

    // MARK: - Model pane

    fileprivate struct ModelRow: Identifiable {
        let id = UUID()
        let name: String
        let sub: String
        let action: String
        let installed: Bool
    }
    private let available: [ModelRow] = [
        .init(name: "Qwen 2.5 · 7B Instruct",       sub: "q5_K_M · 5.2 GB",                  action: "Installed", installed: true),
        .init(name: "Phi-3 · 3.8B Mini",            sub: "q4 · 2.3 GB · faster",             action: "Installed", installed: true),
        .init(name: "Llama 3.3 · 70B Instruct",     sub: "q4 · 39 GB · highest quality",     action: "Download",  installed: false),
        .init(name: "Mistral Small · 22B",          sub: "q4 · 13 GB",                       action: "Download",  installed: false),
    ]

    private var modelPane: some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionHeader("Active model").padding(.bottom, 10)
            activeModelCard.padding(.bottom, 18)

            sectionHeader("Available").padding(.bottom, 8)
            VStack(spacing: 0) {
                ForEach(Array(available.enumerated()), id: \.element.id) { i, m in
                    ModelListRow(model: m, drawTopRule: i > 0)
                }
            }
        }
    }

    private func sectionHeader(_ s: String) -> some View {
        Text(s.uppercased())
            .font(.haloUI(10, weight: .semibold))
            .tracking(0.8)
            .foregroundStyle(Color.haloFgFaint)
    }

    private var activeModelCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(LinearGradient(
                            colors: [Color.haloAccent, Color(red: 0.55, green: 0.45, blue: 0.85)],
                            startPoint: .topLeading, endPoint: .bottomTrailing
                        ))
                    Text("L3")
                        .font(.haloMono(11, weight: .semibold))
                        .foregroundStyle(.white)
                }
                .frame(width: 32, height: 32)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Llama 3.3 · 8B Instruct")
                        .font(.haloUI(13, weight: .medium))
                    Text("q4_K_M · 4.6 GB · 8K context")
                        .font(.haloMono(10.5))
                        .foregroundStyle(Color.haloFgFaint)
                }
                Spacer(minLength: 0)
                Text("Active")
                    .font(.haloMono(10))
                    .foregroundStyle(Color.haloGreen)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Color.haloGreen.opacity(0.18))
                    .overlay(Capsule().stroke(Color.haloGreen.opacity(0.35), lineWidth: 0.5))
                    .clipShape(Capsule())
            }
            .padding(.bottom, 12)

            Rectangle().fill(Color.white.opacity(0.06)).frame(height: 0.5)

            HStack(alignment: .top, spacing: 10) {
                StatView(label: "RAM", value: "3.8", unit: "GB")
                Spacer()
                StatView(label: "Speed", value: "42", unit: "tok/s")
                Spacer()
                StatView(label: "Last used", value: "Just now", unit: "")
            }
            .padding(.top, 12)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(Color.white.opacity(0.04))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.white.opacity(0.10), lineWidth: 0.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // MARK: - Hotkey pane

    private var hotkeyPane: some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionHeader("Summon hotkey").padding(.bottom, 10)
            HotkeyRecorderView()
                .padding(.bottom, 12)

            Text("Press the hotkey from anywhere to bring Halo forward, and again to dismiss.")
                .font(.haloUI(12))
                .foregroundStyle(Color.haloFgDim)
                .lineSpacing(2)
        }
    }
}

// MARK: - Sidebar row with hover

private struct SidebarRow: View {
    let label: String
    let selected: Bool
    let action: () -> Void

    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.haloUI(12.5, weight: selected ? .medium : .regular))
                .foregroundStyle(selected ? Color.haloFg : Color.haloFgDim)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(rowFill)
                        .animation(.easeOut(duration: 0.10), value: hovered)
                )
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
    }

    private var rowFill: Color {
        if selected { return Color.white.opacity(0.10) }
        if hovered  { return Color.white.opacity(0.05) }
        return .clear
    }
}

// MARK: - Available model row with hover + download action

private struct ModelListRow: View {
    let model: SettingsView.ModelRow
    let drawTopRule: Bool

    @State private var hovered = false
    @State private var downloading = false

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.name).font(.haloUI(12.5))
                Text(model.sub)
                    .font(.haloMono(10.5))
                    .foregroundStyle(Color.haloFgFaint)
            }
            Spacer(minLength: 0)
            if model.installed {
                Text("Installed")
                    .font(.haloUI(11))
                    .foregroundStyle(Color.haloFgFaint)
            } else {
                Button(action: { downloading.toggle() }) {
                    Text(downloading ? "Downloading…" : "Download")
                        .font(.haloUI(11, weight: .medium))
                        .foregroundStyle(downloading ? Color.haloFgFaint : Color.haloAccent)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(hovered ? Color.white.opacity(0.04) : .clear)
                .animation(.easeOut(duration: 0.10), value: hovered)
        )
        .overlay(alignment: .top) {
            if drawTopRule {
                Rectangle().fill(Color.white.opacity(0.05)).frame(height: 0.5)
            }
        }
        .contentShape(Rectangle())
        .onHover { hovered = $0 }
    }
}

// MARK: - Section identifiers

enum SettingsSection: String, CaseIterable, Identifiable {
    case general, model, hotkey, voice, shortcuts, privacy, appearance, about
    var id: String { rawValue }
    var label: String {
        switch self {
        case .general:    return "General"
        case .model:      return "Model"
        case .hotkey:     return "Hotkey"
        case .voice:      return "Voice"
        case .shortcuts:  return "Shortcuts"
        case .privacy:    return "Privacy"
        case .appearance: return "Appearance"
        case .about:      return "About"
        }
    }
}
