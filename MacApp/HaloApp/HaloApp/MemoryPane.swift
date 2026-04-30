import SwiftUI

/// Settings → Memory: surfaces every fact the assistant has remembered about
/// the user (the runtime's `Profile`). The user can read the full set and
/// delete individual entries — same forgetting power as the `forget` tool,
/// just direct.
struct MemoryPane: View {
    @State private var facts: [ProfileFact] = []
    @State private var loadState: LoadState = .loading
    @State private var path: String?

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
                if facts.isEmpty {
                    emptyState
                } else {
                    factsList
                }
            }
        }
        .task { await load() }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("WHAT HALO REMEMBERS")
                .font(.haloUI(10, weight: .semibold))
                .tracking(0.8)
                .foregroundStyle(Color.haloFgFaint)

            Text("Facts the assistant has saved as you chatted. These persist across conversations and are part of every prompt.")
                .font(.haloUI(12))
                .foregroundStyle(Color.haloFgDim)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Loaded states

    private var factsList: some View {
        VStack(spacing: 0) {
            ForEach(Array(facts.enumerated()), id: \.element.id) { i, fact in
                MemoryRow(
                    fact: fact,
                    drawTopRule: i > 0,
                    onForget: { Task { await forget(fact) } }
                )
            }
        }
        .background(Color.white.opacity(0.02))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 0.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Text("Nothing remembered yet.")
                .font(.haloUI(13, weight: .medium))
                .foregroundStyle(Color.haloFg)
            Text("Tell Halo something about yourself — preferences, your dog's name, where you live — and it'll save it here.")
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

    private func load() async {
        loadState = .loading
        do {
            let resp = try await RuntimeClient.shared.profile()
            facts    = resp.facts
            path     = resp.path
            loadState = .ready
        } catch {
            loadState = .error(error.localizedDescription)
        }
    }

    private func forget(_ fact: ProfileFact) async {
        // Optimistic remove — if the call fails, restore.
        let prev = facts
        facts.removeAll { $0.id == fact.id }
        do {
            _ = try await RuntimeClient.shared.forget(key: fact.key)
        } catch {
            facts = prev
            loadState = .error(error.localizedDescription)
        }
    }
}

// MARK: - Row

private struct MemoryRow: View {
    let fact: ProfileFact
    let drawTopRule: Bool
    let onForget: () -> Void

    @State private var hovered = false
    @State private var confirming = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // Key — uppercase mono, like the rest of the design's labels.
            Text(fact.key.uppercased())
                .font(.haloMono(10))
                .tracking(0.8)
                .foregroundStyle(Color.haloFgFaint)
                .frame(width: 130, alignment: .leading)
                .padding(.top, 1)

            // Value
            Text(fact.value)
                .font(.haloUI(13))
                .foregroundStyle(Color.haloFg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)

            // Forget control — appears on hover; two-tap to confirm.
            forgetControl
                .frame(width: 64, alignment: .trailing)
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
        .onHover { isIn in
            hovered = isIn
            if !isIn { confirming = false }
        }
    }

    @ViewBuilder
    private var forgetControl: some View {
        if confirming {
            Button(action: onForget) {
                Text("Confirm")
                    .font(.haloUI(11, weight: .medium))
                    .foregroundStyle(Color.haloRunning)
            }
            .buttonStyle(.plain)
        } else if hovered {
            Button(action: { confirming = true }) {
                Text("Forget")
                    .font(.haloUI(11))
                    .foregroundStyle(Color.haloFgDim)
            }
            .buttonStyle(.plain)
        } else {
            Color.clear
        }
    }
}
