import SwiftUI

/// Two-pane settings window: sidebar nav + content.
struct SettingsView: View {
    @Environment(AppState.self) private var state
    var onClose: () -> Void = {}
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
        .onKeyPress(.escape) {
            onClose()
            return .handled
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            WindowCloseButton(action: onClose)
                .padding(.trailing, 4)
            Text("Settings").font(.haloUI(13, weight: .semibold))
            Spacer(minLength: 0)
            Text("v1.0.4")
                .font(.haloMono(10.5))
                .foregroundStyle(Color.haloFgFaint)
        }
        .padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 10)
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
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 0) {
                switch selected {
                case .model:     modelPane
                case .memory:    MemoryPane()
                case .shortcuts: ShortcutsPane()
                case .hotkey:    hotkeyPane
                default:
                    Text(selected.label)
                        .font(.haloUI(13, weight: .medium))
                        .foregroundStyle(Color.haloFgDim)
                        .padding(20)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20).padding(.top, 14).padding(.bottom, 20)
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    // MARK: - Model pane

    private var modelPane: some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionHeader("Endpoint").padding(.bottom, 10)
            EndpointCard().padding(.bottom, 18)

            sectionHeader("Active model").padding(.bottom, 10)
            activeModelCard.padding(.bottom, 18)

            HStack(alignment: .firstTextBaseline) {
                sectionHeader("Vetted models")
                Spacer(minLength: 0)
                // Honest framing — bundled inference doesn't ship until
                // v8.5. Until then the catalog is "manage your library."
                Text("\(SystemInfo.totalRAMGB) GB RAM · \(SystemInfo.freeDiskGB()) GB free")
                    .font(.haloMono(10))
                    .foregroundStyle(Color.haloFgFaint)
            }
            .padding(.bottom, 4)
            Text("Vetted GGUFs from HuggingFace, pinned by SHA-256. Download to use offline.")
                .font(.haloUI(11))
                .foregroundStyle(Color.haloFgFaint)
                .padding(.bottom, 10)

            VStack(spacing: 0) {
                ForEach(Array(ModelCatalog.shared.entries.enumerated()), id: \.element.id) { i, entry in
                    CatalogModelRow(entry: entry, drawTopRule: i > 0)
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
        let status = state.runtimeStatus
        // Compose "<quant> · <size> · <ctx>" from whichever pieces the
        // runtime gave us. When all three are missing we show a single
        // dash rather than an empty line.
        let subBits: [String] = [
            status.quantization,
            status.sizeLabel,
            status.contextLabel.map { "\($0) context" },
        ].compactMap { $0 }
        let sub = subBits.isEmpty ? "—" : subBits.joined(separator: " · ")

        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(LinearGradient(
                            colors: [Color.haloAccent, Color(red: 0.55, green: 0.45, blue: 0.85)],
                            startPoint: .topLeading, endPoint: .bottomTrailing
                        ))
                    Text(modelGlyph(for: status.modelLabel))
                        .font(.haloMono(11, weight: .semibold))
                        .foregroundStyle(.white)
                }
                .frame(width: 32, height: 32)

                VStack(alignment: .leading, spacing: 2) {
                    Text(status.modelLabel)
                        .font(.haloUI(13, weight: .medium))
                        .lineLimit(1)
                    Text(sub)
                        .font(.haloMono(10.5))
                        .foregroundStyle(Color.haloFgFaint)
                }
                Spacer(minLength: 0)
                Text(status.connected ? "Active" : "Offline")
                    .font(.haloMono(10))
                    .foregroundStyle(status.connected ? Color.haloGreen : Color.haloFgFaint)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background((status.connected ? Color.haloGreen : Color.haloFgFaint).opacity(0.18))
                    .overlay(Capsule().stroke((status.connected ? Color.haloGreen : Color.haloFgFaint).opacity(0.35), lineWidth: 0.5))
                    .clipShape(Capsule())
            }
            .padding(.bottom, 12)

            Rectangle().fill(Color.white.opacity(0.06)).frame(height: 0.5)

            HStack(alignment: .top, spacing: 10) {
                StatView(
                    label: "RAM",
                    value: status.sizeNumber ?? "—",
                    unit:  status.sizeNumber == nil ? "" : "GB"
                )
                Spacer()
                StatView(
                    label: "Speed",
                    value: status.tpsNumber ?? "—",
                    unit:  status.tpsNumber == nil ? "" : "tok/s"
                )
                Spacer()
                StatView(
                    label: "Context",
                    value: status.contextLabel ?? "—",
                    unit:  ""
                )
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

    /// 2-char glyph for the active-model badge. Picks the first letter and
    /// the first digit from the model id — "qwen3.5-2b" → "Q3", "llama-3.3"
    /// → "L3". Falls back to "··" when neither is available.
    private func modelGlyph(for id: String) -> String {
        let s = id.lowercased()
        let letter = s.first { $0.isLetter }.map { String($0).uppercased() }
        let digit  = s.first { $0.isNumber }.map { String($0) }
        if let l = letter, let d = digit { return "\(l)\(d)" }
        if let l = letter                { return l }
        return "··"
    }

    // MARK: - Hotkey pane

    private var hotkeyPane: some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionHeader("Summon hotkey").padding(.bottom, 10)
            HotkeyRecorderView()
                .padding(.bottom, 12)

            Text("Press the hotkey from anywhere to bring Milo forward, and again to dismiss.")
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

// MARK: - Catalog row — live model entry with download/delete affordances

private struct CatalogModelRow: View {
    let entry: ModelEntry
    let drawTopRule: Bool

    @State private var hovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.model.name).font(.haloUI(12.5))
                    Text(specLine).font(.haloMono(10.5))
                        .foregroundStyle(Color.haloFgFaint)
                    Text(entry.model.tagline)
                        .font(.haloUI(11))
                        .foregroundStyle(Color.haloFgDim)
                        .padding(.top, 2)
                }
                Spacer(minLength: 0)
                actionButton
            }

            // Inline progress when downloading. Below the row, full width.
            if let dl = entry.downloader, case .running(let p, let bps) = dl.state {
                progressStrip(progress: p, bps: bps)
                    .padding(.top, 8)
            } else if let dl = entry.downloader, case .verifying = dl.state {
                progressStrip(progress: 1.0, bps: 0, label: "Verifying SHA-256…")
                    .padding(.top, 8)
            } else if let dl = entry.downloader, case .failed(let reason) = dl.state {
                Text("Failed: \(reason)")
                    .font(.haloUI(10.5))
                    .foregroundStyle(Color.haloWarn)
                    .padding(.top, 4)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 12)
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

    private var specLine: String {
        let sizeGB = Double(entry.model.sizeBytes) / 1_000_000_000
        return "\(entry.model.params) · \(entry.model.quant) · \(String(format: "%.1f GB", sizeGB)) · \(entry.model.context / 1024)K ctx"
    }

    @ViewBuilder
    private var actionButton: some View {
        switch entry.availability {
        case .ramBlocked(let need):
            Text("Needs \(need)GB+")
                .font(.haloUI(10.5, weight: .medium))
                .foregroundStyle(Color.haloFgFaint)
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(Color.white.opacity(0.05))
                .clipShape(Capsule())
        case .available:
            Button(action: { startDownloadWithDiskCheck(entry) }) {
                Text("Download")
                    .font(.haloUI(11, weight: .medium))
                    .foregroundStyle(Color.haloAccent)
            }
            .buttonStyle(.plain)
        case .downloading:
            // Cancel-only — pause is intentionally not exposed for the
            // multi-file MLX downloader. Cancelling leaves already-
            // downloaded files on disk; clicking Download again resumes.
            Button(action: { ModelCatalog.shared.cancelOrDelete(entry.id) }) {
                Text("Cancel")
                    .font(.haloUI(10.5))
                    .foregroundStyle(Color.haloFgDim)
            }
            .buttonStyle(.plain)
        case .installed:
            HStack(spacing: 8) {
                HStack(spacing: 4) {
                    Circle().fill(Color.haloGreen).frame(width: 5, height: 5)
                    Text("Installed").font(.haloUI(10.5))
                }
                .foregroundStyle(Color.haloFgDim)
                Button(action: { confirmDelete(entry) }) {
                    Text("Delete")
                        .font(.haloUI(10.5))
                        .foregroundStyle(Color.haloWarn)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func progressStrip(progress: Double, bps: Int64, label: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ProgressBarView(value: progress)
            HStack {
                Text(label ?? String(format: "%.1f%%", progress * 100))
                Spacer(minLength: 0)
                if bps > 0 {
                    Text(formatBPS(bps))
                }
                Spacer(minLength: 0)
                Text(remainingString(progress: progress))
            }
            .font(.haloMono(10))
            .foregroundStyle(Color.haloFgFaint)
            .monospacedDigit()
        }
    }

    private func formatBPS(_ bps: Int64) -> String {
        if bps > 1_000_000 {
            return String(format: "%.1f MB/s", Double(bps) / 1_000_000)
        }
        return String(format: "%.0f KB/s", Double(bps) / 1_000)
    }

    private func remainingString(progress: Double) -> String {
        let bytesLeft = Int64(Double(entry.model.sizeBytes) * (1.0 - progress))
        let mb = Double(bytesLeft) / 1_000_000
        return String(format: "%.0f MB left", mb)
    }

    /// Pre-flight disk check before kicking off a multi-GB download.
    /// Catches the "downloading 4.6GB onto a near-full disk" case where
    /// the download fails halfway with an unhelpful "out of space" error.
    /// Need: model size + 1GB working buffer.
    private func startDownloadWithDiskCheck(_ entry: ModelEntry) {
        let needGB = Int(ceil(Double(entry.model.sizeBytes) / 1_000_000_000)) + 1
        let freeGB = SystemInfo.freeDiskGB()
        if freeGB < needGB {
            let alert = NSAlert()
            alert.messageText = "Not enough disk space"
            alert.informativeText = "\(entry.model.name) needs about \(needGB) GB, but only \(freeGB) GB is free. Free some space and try again."
            alert.alertStyle = .warning
            alert.addButton(withTitle: "OK")
            alert.runModal()
            return
        }
        ModelCatalog.shared.startDownload(for: entry.id)
    }

    private func confirmDelete(_ entry: ModelEntry) {
        let alert = NSAlert()
        alert.messageText = "Delete \(entry.model.name)?"
        let sizeGB = Double(entry.model.sizeBytes) / 1_000_000_000
        alert.informativeText = "Frees \(String(format: "%.1f GB", sizeGB)) of disk. You'll need to download it again to use it."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Delete")
        alert.addButton(withTitle: "Cancel")
        // First button defaults to .return; mark Delete as destructive
        // so it picks up the right tint and Cancel as the safe default.
        if alert.buttons.count >= 2 {
            alert.buttons[0].hasDestructiveAction = true
            alert.buttons[1].keyEquivalent = "\u{1b}"  // ESC
        }
        if alert.runModal() == .alertFirstButtonReturn {
            ModelCatalog.shared.cancelOrDelete(entry.id)
        }
    }
}

// MARK: - Endpoint card

/// "Where does the brain get its model from?" — the orchestrator
/// contract from design.md §3.8 surfaced in the Settings UI. Bundled
/// mode is intentionally disabled until v8.5 ships llama-server; the
/// preview tag is honest about that.
private struct EndpointCard: View {
    @Environment(AppState.self) private var state

    /// Local working copy so the user can type the URL without us
    /// firing a runtime restart on every keystroke. Committed via
    /// the explicit Apply button.
    @State private var draftURL: String = ""
    @State private var hasLoadedDraft = false

    var body: some View {
        @Bindable var state = state
        VStack(alignment: .leading, spacing: 0) {
            // Mode toggle — segmented. Bundled is fully functional now
            // that v8.5 ships llama-server in Resources/llama-runtime/.
            HStack(spacing: 8) {
                ForEach(EndpointMode.allCases) { mode in
                    EndpointModePill(
                        mode: mode,
                        selected: state.endpointMode == mode,
                        disabled: false,
                        action: {
                            if state.endpointMode != mode {
                                state.endpointMode = mode  // didSet → AppDelegate restarts the stack
                            }
                        }
                    )
                }
                Spacer(minLength: 0)
            }
            .padding(.bottom, 12)

            switch state.endpointMode {
            case .external:
                externalURLRow(state: state)
            case .bundled:
                bundledStatusRow
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(Color.white.opacity(0.04))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.white.opacity(0.10), lineWidth: 0.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .onAppear {
            if !hasLoadedDraft {
                draftURL = state.externalEndpointURL
                hasLoadedDraft = true
            }
        }
    }

    @ViewBuilder
    private func externalURLRow(state: AppState) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("OpenAI-compatible endpoint")
                .font(.haloUI(11, weight: .medium))
                .foregroundStyle(Color.haloFgDim)

            HStack(spacing: 8) {
                TextField("http://localhost:1234/v1", text: $draftURL)
                    .textFieldStyle(.plain)
                    .font(.haloMono(12))
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(Color.black.opacity(0.18))
                    .overlay(
                        RoundedRectangle(cornerRadius: 7, style: .continuous)
                            .stroke(Color.white.opacity(0.10), lineWidth: 0.5)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))

                Button(action: applyURL) {
                    Text("Apply")
                }
                .buttonStyle(HaloButtonStyle(fontSize: 12, paddingH: 12, paddingV: 6))
                .disabled(draftURL.trimmingCharacters(in: .whitespaces) == state.externalEndpointURL)
            }

            Text("LM Studio (port 1234), Ollama (11434), or any OpenAI-compatible server.")
                .font(.haloUI(11))
                .foregroundStyle(Color.haloFgFaint)
        }
    }

    @ViewBuilder
    private var bundledStatusRow: some View {
        let installed = ModelCatalog.shared.entries.filter {
            if case .installed = $0.availability { return true }
            return false
        }
        if installed.isEmpty {
            Text("No models installed yet. Download one from the list below to start using built-in inference.")
                .font(.haloUI(11.5))
                .foregroundStyle(Color.haloFgDim)
                .lineSpacing(2)
                .frame(maxWidth: 420, alignment: .leading)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text("Active model")
                        .font(.haloUI(11, weight: .medium))
                        .foregroundStyle(Color.haloFgDim)
                    Spacer(minLength: 0)
                    modelServerStatusPill
                }
                BundledModelPicker(installed: installed)
            }
        }
    }

    /// Pill showing live llama-server status. Empty in steady-state
    /// (when running) so we don't add chrome to the most common case.
    @ViewBuilder
    private var modelServerStatusPill: some View {
        switch state.modelServerState {
        case .starting(let id):
            HStack(spacing: 5) {
                ProgressView().controlSize(.mini)
                Text("Loading \(shortName(for: id))…")
            }
            .font(.haloUI(10.5))
            .foregroundStyle(Color.haloAccent)
        case .crashed(let reason):
            HStack(spacing: 5) {
                Circle().fill(Color.haloWarn).frame(width: 5, height: 5)
                Text(reason).lineLimit(1).truncationMode(.tail)
            }
            .font(.haloUI(10.5))
            .foregroundStyle(Color.haloWarn)
        case .running, .stopped, .notStarted:
            EmptyView()
        }
    }

    /// Strip everything before the last `·` and the quant suffix —
    /// "qwen2.5-1.5b-instruct-q4km" becomes "1.5b". Best-effort.
    private func shortName(for id: String) -> String {
        if let m = id.range(of: "[0-9]+\\.[0-9]+b|[0-9]+b", options: .regularExpression) {
            return String(id[m])
        }
        return id
    }

    private func applyURL() {
        let trimmed = draftURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != state.externalEndpointURL else { return }
        state.externalEndpointURL = trimmed
        // URL changes don't fire onEndpointChange (avoids per-keystroke
        // restart). Trigger an explicit restart here.
        AppDelegate.shared?.applyEndpointChanges()
    }
}

/// Compact picker shown when bundled mode is on and at least one model
/// is installed. Tapping a row makes that model the one llama-server
/// is loaded with — AppState.selectedModelId change kicks AppDelegate
/// to restart ModelServer.
private struct BundledModelPicker: View {
    let installed: [ModelEntry]
    @Environment(AppState.self) private var state

    private var isSwapping: Bool {
        if case .starting = state.modelServerState { return true }
        return false
    }

    var body: some View {
        @Bindable var state = state
        VStack(spacing: 4) {
            ForEach(installed) { entry in
                let isSelected = (state.selectedModelId ?? installed.first?.id) == entry.id
                Button(action: {
                    guard !isSwapping else { return }
                    if state.selectedModelId != entry.id {
                        state.selectedModelId = entry.id
                    }
                }) {
                    HStack(spacing: 10) {
                        ZStack {
                            Circle().stroke(Color.white.opacity(isSelected ? 0.55 : 0.18), lineWidth: 1)
                            if isSelected {
                                Circle().fill(Color.haloAccent).padding(3)
                            }
                        }
                        .frame(width: 12, height: 12)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(entry.model.name).font(.haloUI(12))
                            Text("\(entry.model.params) · \(entry.model.quant)")
                                .font(.haloMono(10))
                                .foregroundStyle(Color.haloFgFaint)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .background(
                        RoundedRectangle(cornerRadius: 6)
                            .fill(isSelected ? Color.haloAccent.opacity(0.08) : .clear)
                    )
                    .opacity(isSwapping && !isSelected ? 0.4 : 1)
                }
                .buttonStyle(.plain)
                .disabled(isSwapping)
            }
        }
    }
}

private struct EndpointModePill: View {
    let mode: EndpointMode
    let selected: Bool
    let disabled: Bool
    let action: () -> Void

    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(mode.label)
                    .font(.haloUI(12, weight: selected ? .medium : .regular))
                if disabled {
                    Text("preview")
                        .font(.haloUI(9, weight: .semibold))
                        .tracking(0.6)
                        .textCase(.uppercase)
                        .foregroundStyle(Color.haloAccent.opacity(0.85))
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(Color.haloAccent.opacity(0.15))
                        .clipShape(Capsule())
                }
            }
            .foregroundStyle(disabled ? Color.haloFgFaint
                              : (selected ? Color.haloFg : Color.haloFgDim))
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(selected ? Color.white.opacity(0.10)
                          : (hovered && !disabled ? Color.white.opacity(0.05) : .clear))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .stroke(selected ? Color.white.opacity(0.18) : Color.white.opacity(0.08),
                            lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .help(disabled ? "Built-in inference ships in v8.5" : "")
    }
}

// MARK: - Section identifiers

enum SettingsSection: String, CaseIterable, Identifiable {
    case general, model, memory, hotkey, voice, shortcuts, privacy, appearance, about
    var id: String { rawValue }
    var label: String {
        switch self {
        case .general:    return "General"
        case .model:      return "Model"
        case .memory:     return "Memory"
        case .hotkey:     return "Hotkey"
        case .voice:      return "Voice"
        case .shortcuts:  return "Shortcuts"
        case .privacy:    return "Privacy"
        case .appearance: return "Appearance"
        case .about:      return "About"
        }
    }
}
