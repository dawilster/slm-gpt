import SwiftUI

/// Settings → Shortcuts: enumerates the user's macOS Shortcuts library
/// as the runtime sees it. Mirrors `MemoryPane` for visual consistency.
///
/// This is the surface that answers "what can Milo run for me?" without
/// the user having to ask via chat. The list shown here is the same list
/// the model gets from `list_shortcuts` and what `run_shortcut` resolves
/// against, so a name visible here is callable from the agent.
struct ShortcutsPane: View {
    @State private var shortcuts: [ShortcutEntry] = []
    @State private var loadState: LoadState = .loading
    @State private var fromCache = false
    @State private var refreshing = false

    enum LoadState: Equatable {
        case loading
        case ready
        case error(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header.padding(.bottom, 12)

            switch loadState {
            case .loading:
                placeholder("Loading…")
            case .error(let msg):
                placeholder("Couldn't load: \(msg)", isError: true)
            case .ready:
                if shortcuts.isEmpty {
                    emptyState
                } else {
                    shortcutsList
                }
            }
        }
        .task { await load(force: false) }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("AVAILABLE SHORTCUTS")
                    .font(.haloUI(10, weight: .semibold))
                    .tracking(0.8)
                    .foregroundStyle(Color.haloFgFaint)
                Spacer(minLength: 0)
                refreshButton
            }

            Text("Milo can trigger any of these by name from chat — try \"create a note about dinner, then start a 20-minute timer.\" Add or rename in the Shortcuts app, then refresh.")
                .font(.haloUI(12))
                .foregroundStyle(Color.haloFgDim)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var refreshButton: some View {
        Button(action: { Task { await load(force: true) } }) {
            HStack(spacing: 4) {
                if refreshing {
                    ProgressView()
                        .controlSize(.mini)
                        .scaleEffect(0.7)
                        .frame(width: 10, height: 10)
                } else {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 10, weight: .medium))
                }
                Text(refreshing ? "Refreshing…" : "Refresh")
                    .font(.haloUI(11))
            }
            .foregroundStyle(Color.haloFgDim)
        }
        .buttonStyle(.plain)
        .disabled(refreshing)
    }

    // MARK: - Loaded states

    private var shortcutsList: some View {
        VStack(spacing: 0) {
            ForEach(Array(shortcuts.enumerated()), id: \.element.id) { i, entry in
                ShortcutRow(name: entry.name, drawTopRule: i > 0)
            }
        }
        .background(Color.white.opacity(0.02))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 0.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(alignment: .bottomTrailing) {
            if fromCache {
                Text("cached")
                    .font(.haloMono(9.5))
                    .foregroundStyle(Color.haloFgFaint)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .padding(8)
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Text("No shortcuts found.")
                .font(.haloUI(13, weight: .medium))
                .foregroundStyle(Color.haloFg)
            Text("Open the Shortcuts app and add one — Apple's gallery is a good starting point. They'll appear here next time you refresh.")
                .font(.haloUI(12))
                .foregroundStyle(Color.haloFgDim)
                .multilineTextAlignment(.leading)
                .lineSpacing(2)
                .frame(maxWidth: 380, alignment: .leading)
        }
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func placeholder(_ msg: String, isError: Bool = false) -> some View {
        Text(msg)
            .font(.haloUI(12))
            .foregroundStyle(isError ? Color.haloRunning : Color.haloFgDim)
            .padding(.vertical, 16)
    }

    // MARK: - Data

    private func load(force: Bool) async {
        if force {
            refreshing = true
        } else {
            loadState = .loading
        }
        defer { refreshing = false }
        do {
            let resp = try await RuntimeClient.shared.shortcuts(force: force)
            shortcuts = resp.shortcuts
            fromCache = resp.fromCache
            loadState = .ready
        } catch {
            loadState = .error(error.localizedDescription)
        }
    }
}

// MARK: - Row

private struct ShortcutRow: View {
    let name: String
    let drawTopRule: Bool

    @State private var hovered = false

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "bolt.fill")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Color.haloAccent.opacity(0.85))
                .frame(width: 14)

            Text(name)
                .font(.haloUI(13))
                .foregroundStyle(Color.haloFg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
                .lineLimit(1)
                .truncationMode(.tail)

            if hovered {
                Text("Ask Milo")
                    .font(.haloUI(10.5))
                    .foregroundStyle(Color.haloFgFaint)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(
            Color.white.opacity(hovered ? 0.04 : 0)
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
