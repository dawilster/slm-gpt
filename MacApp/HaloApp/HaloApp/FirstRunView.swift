import SwiftUI

/// First-run model download. Wired to the real ModelDownloader for the
/// smallest catalog entry. The user can pause/resume from here, or click
/// "Choose another" to open Settings → Model and pick a different one.
///
/// "Done" fires when the download verifies + completes (`.installed`).
struct FirstRunView: View {
    var onDone: () -> Void = {}
    var onClose: () -> Void = {}
    var onChooseAnother: () -> Void = {}

    /// First entry in the catalog whose RAM requirements pass — usually
    /// the smallest. If the catalog is empty we degrade to the original
    /// stub behavior so first-run still completes.
    private var entry: ModelEntry? {
        ModelCatalog.shared.entries.first {
            if case .ramBlocked = $0.availability { return false }
            return true
        }
    }

    /// Bound to the entry so SwiftUI re-renders on availability changes.
    @State private var trigger = 0

    var body: some View {
        DockShell {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 14) {
                    HaloOrb(size: 36, state: orbState)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(headlineText)
                            .font(.haloUI(15, weight: .semibold))
                            .tracking(-0.15)
                        Text(subText)
                            .font(.haloUI(12))
                            .foregroundStyle(Color.haloFgDim)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.bottom, 18)

                modelCard
                    .padding(.bottom, 14)

                HStack {
                    HStack(spacing: 6) {
                        Circle().fill(verifiedColor).frame(width: 5, height: 5)
                        Text(verifiedLabel)
                    }
                    .font(.haloUI(11.5))
                    .foregroundStyle(Color.haloFgFaint)

                    Spacer(minLength: 0)

                    HStack(spacing: 8) {
                        Button(action: cancel) {
                            Text("Cancel")
                        }
                        .buttonStyle(HaloButtonStyle(fontSize: 11.5, paddingH: 10, paddingV: 5))
                        .disabled(cancelDisabled)

                        Button(action: onChooseAnother) {
                            Text("Choose another")
                        }
                        .buttonStyle(HaloButtonStyle(fontSize: 11.5, paddingH: 10, paddingV: 5))
                    }
                }
            }
            .padding(.horizontal, 28).padding(.top, 26).padding(.bottom, 22)
        }
        .overlay(alignment: .topLeading) {
            WindowCloseButton(action: onClose)
                .padding(14)
        }
        .onKeyPress(.escape) {
            onClose()
            return .handled
        }
        .onAppear {
            startDownloadIfNeeded()
            // Hook the entry's downloader so SwiftUI re-renders on each
            // progress tick (the @Observable on ModelEntry covers most
            // changes; this nudge handles the downloader-attached case).
            if let dl = entry?.downloader {
                dl.onStateChange = { _ in trigger &+= 1 }
            }
        }
        .onChange(of: entry?.availability) { _, new in
            if case .installed = new {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { onDone() }
            }
        }
    }

    // MARK: - Driving the download

    private func startDownloadIfNeeded() {
        guard let entry else { return }
        switch entry.availability {
        case .available, .downloading:
            ModelCatalog.shared.startDownload(for: entry.id)
        case .installed:
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { onDone() }
        case .ramBlocked:
            break  // shouldn't happen — entry getter filters these out
        }
    }

    /// Cancel the in-flight download. Files already on disk stay; if
    /// the user re-summons FirstRun, the loop resumes from where it
    /// stopped (per-file granularity).
    private func cancel() {
        guard let entry else { return }
        ModelCatalog.shared.cancelOrDelete(entry.id)
    }

    // MARK: - Derived UI bits

    private var orbState: HaloMenubarState {
        guard let entry else { return .offline }
        if case .installed = entry.availability { return .idle }
        if let dl = entry.downloader, case .verifying = dl.state { return .thinking }
        if let dl = entry.downloader, case .running = dl.state { return .loading }
        return .loading
    }

    private var headlineText: String {
        guard let entry else { return "No catalog entry" }
        if case .installed = entry.availability { return "All set." }
        if let dl = entry.downloader, case .verifying = dl.state { return "Verifying" }
        return "Downloading your model"
    }

    private var subText: String {
        if entry == nil {
            return "Couldn't find a model that fits this Mac."
        }
        if let entry, case .installed = entry.availability {
            return "Milo is ready. Click anywhere to begin."
        }
        return "This happens once. Milo runs entirely on your Mac after this."
    }

    private var verifiedLabel: String {
        guard let entry, let dl = entry.downloader else { return "Pinned revision" }
        switch dl.state {
        case .verifying: return "Verifying…"
        case .finished:  return "Verified"
        case .failed(let r): return "Failed · \(r)"
        default: return "Pinned revision"
        }
    }

    private var verifiedColor: Color {
        guard let entry, let dl = entry.downloader else { return Color.haloFgFaint }
        switch dl.state {
        case .finished: return Color.haloGreen
        case .failed:   return Color.haloWarn
        default:        return Color.haloFgFaint
        }
    }

    private var cancelDisabled: Bool {
        guard let entry, let dl = entry.downloader else { return true }
        if case .running = dl.state { return false }
        return true
    }

    @ViewBuilder
    private var modelCard: some View {
        if let entry {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Text("\(entry.model.id) · \(entry.model.quant.lowercased())")
                        .font(.haloMono(12))
                    Spacer(minLength: 0)
                    Text(progressBytesLabel(for: entry))
                        .font(.haloMono(11))
                        .foregroundStyle(Color.haloFgDim)
                        .monospacedDigit()
                }

                ProgressBarView(value: progressFraction(for: entry))

                HStack {
                    Text(String(format: "%.1f%%", progressFraction(for: entry) * 100))
                    Spacer(minLength: 0)
                    Text(speedLabel(for: entry))
                    Spacer(minLength: 0)
                    Text(remainingLabel(for: entry))
                }
                .font(.haloMono(10.5))
                .foregroundStyle(Color.haloFgFaint)
                .monospacedDigit()
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .background(Color.white.opacity(0.03))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Color.white.opacity(0.08), lineWidth: 0.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        } else {
            Text("Empty catalog. Open Settings → Model to point at your own endpoint.")
                .font(.haloUI(12))
                .foregroundStyle(Color.haloFgDim)
                .padding(14)
        }
    }

    private func progressFraction(for entry: ModelEntry) -> Double {
        if case .installed = entry.availability { return 1.0 }
        return entry.downloader?.state.progress ?? 0
    }

    private func progressBytesLabel(for entry: ModelEntry) -> String {
        let totalGB = Double(entry.model.sizeBytes) / 1_000_000_000
        let doneGB = totalGB * progressFraction(for: entry)
        return String(format: "%.2f / %.2f GB", doneGB, totalGB)
    }

    private func speedLabel(for entry: ModelEntry) -> String {
        guard let dl = entry.downloader, case .running(_, let bps) = dl.state, bps > 0 else { return "—" }
        if bps > 1_000_000 {
            return String(format: "%.1f MB/s", Double(bps) / 1_000_000)
        }
        return String(format: "%.0f KB/s", Double(bps) / 1_000)
    }

    private func remainingLabel(for entry: ModelEntry) -> String {
        let p = progressFraction(for: entry)
        guard let dl = entry.downloader, case .running(_, let bps) = dl.state, bps > 0, p < 1.0 else {
            return "—"
        }
        let bytesLeft = Double(entry.model.sizeBytes) * (1.0 - p)
        let secondsLeft = Int(bytesLeft / Double(bps))
        let m = secondsLeft / 60
        let s = secondsLeft % 60
        return m > 0 ? "~\(m)m \(String(format: "%02d", s))s remaining" : "~\(s)s remaining"
    }
}
