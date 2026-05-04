import Foundation
import os

private let log = Logger(subsystem: "halo.runtime", category: "catalog")

/// One row from the bundled `catalog.json` manifest. Data only — see
/// `ModelEntry` for the live, observable wrapper that the UI renders.
struct CatalogModel: Decodable, Sendable {
    let id: String
    let name: String
    let tagline: String
    let params: String
    let quant: String
    let sizeBytes: Int64
    let ramRequiredMB: Int
    let context: Int
    let url: String
    let sha256: String
    let minRamGB: Int
}

private struct CatalogManifest: Decodable {
    let version: Int
    let models: [CatalogModel]
}

/// Per-entry availability — a UI-shaped enum the picker can switch on.
enum EntryAvailability: Equatable {
    case available           // not yet downloaded, supported on this Mac
    case downloading         // a ModelDownloader is active
    case installed           // GGUF is on disk and verified
    case ramBlocked(Int)     // associated value: minRamGB this entry needs
}

/// Observable wrapper for one catalog row. The UI renders these; mutating
/// `download` / `cancel` / `delete` affects on-disk state and emits state
/// changes via the @Observable parent ModelCatalog.
@MainActor
@Observable
final class ModelEntry: Identifiable {
    let model: CatalogModel
    var id: String { model.id }

    /// Live download state when one is active. Nil until first
    /// `startDownload()` call (or until catalog scan finds a leftover
    /// `.partial` from a previous app session).
    var downloader: ModelDownloader?

    /// Cached availability — recomputed from disk + downloader state +
    /// system RAM. The catalog refreshes this on disk events.
    fileprivate(set) var availability: EntryAvailability

    /// File path the model lives at when installed.
    let installedURL: URL

    init(model: CatalogModel, installedURL: URL, availability: EntryAvailability) {
        self.model = model
        self.installedURL = installedURL
        self.availability = availability
    }
}

/// Loads the bundled catalog, cross-references the models directory on
/// disk, and exposes a list of `ModelEntry` for the UI. Singleton because
/// downloads are app-scoped and should survive Settings being closed and
/// reopened.
@MainActor
@Observable
final class ModelCatalog {
    static let shared = ModelCatalog()

    private(set) var entries: [ModelEntry] = []

    /// Where downloaded GGUFs live. `~/Library/Application Support/HaloApp/models/`.
    let modelsDirectory: URL

    private init() {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        self.modelsDirectory = appSupport
            .appendingPathComponent("HaloApp/models", isDirectory: true)
        try? FileManager.default.createDirectory(at: modelsDirectory, withIntermediateDirectories: true)
        load()
    }

    // MARK: - Manifest loading

    private func load() {
        guard let url = Bundle.main.url(forResource: "catalog", withExtension: "json") else {
            log.error("catalog.json not in bundle")
            return
        }
        do {
            let data = try Data(contentsOf: url)
            let manifest = try JSONDecoder().decode(CatalogManifest.self, from: data)
            entries = manifest.models.map { makeEntry(from: $0) }
            log.info("loaded \(self.entries.count) catalog entries; \(self.installedCount()) installed")
        } catch {
            log.error("catalog parse failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func installedCount() -> Int {
        entries.filter { if case .installed = $0.availability { return true } else { return false } }.count
    }

    private func makeEntry(from model: CatalogModel) -> ModelEntry {
        let dest = installedURL(for: model)
        let avail = computeAvailability(for: model, at: dest)
        return ModelEntry(model: model, installedURL: dest, availability: avail)
    }

    private func installedURL(for model: CatalogModel) -> URL {
        modelsDirectory.appendingPathComponent("\(model.id).gguf")
    }

    private func computeAvailability(for model: CatalogModel, at dest: URL) -> EntryAvailability {
        if model.minRamGB > SystemInfo.totalRAMGB {
            return .ramBlocked(model.minRamGB)
        }
        if FileManager.default.fileExists(atPath: dest.path) {
            // Trust on-disk presence + correct size as a proxy for installed.
            // A full SHA verify happens lazily on first ModelDownloader.start()
            // touching this entry — too expensive to do up front.
            if let attrs = try? FileManager.default.attributesOfItem(atPath: dest.path),
               let size = attrs[.size] as? Int64,
               size == model.sizeBytes {
                return .installed
            }
            // Wrong size = corrupt. Treat as available; downloader will overwrite.
            log.error("on-disk size mismatch for \(model.id, privacy: .public) — treating as available")
            try? FileManager.default.removeItem(at: dest)
        }
        // Look for a partial download from a prior session.
        let partial = dest.appendingPathExtension("partial")
        if FileManager.default.fileExists(atPath: partial.path) {
            // We could probe the size and report "paused at X%", but
            // exposing that as a pre-bound downloader requires the user
            // to hit Resume to actually attach. Treat as available; the
            // downloader's start() handles resume.
            return .available
        }
        return .available
    }

    // MARK: - Public actions

    /// Begin (or resume) downloading a model. Wires up a ModelDownloader
    /// and pushes availability to `.downloading` until it finishes.
    func startDownload(for entryId: String) {
        guard let entry = entries.first(where: { $0.id == entryId }) else { return }

        if entry.downloader == nil {
            guard let url = URL(string: entry.model.url) else {
                log.error("invalid url for \(entryId, privacy: .public)")
                return
            }
            let dl = ModelDownloader(
                modelId: entry.id,
                url: url,
                expectedSHA256: entry.model.sha256,
                expectedSize: entry.model.sizeBytes,
                destinationURL: entry.installedURL
            )
            dl.onStateChange = { [weak self, weak entry] state in
                guard let self, let entry else { return }
                self.handleDownloadState(state, for: entry)
            }
            entry.downloader = dl
        }
        entry.availability = .downloading
        entry.downloader?.start()
    }

    func pauseDownload(for entryId: String) {
        entries.first(where: { $0.id == entryId })?.downloader?.pause()
    }

    /// Cancel an in-progress download or delete an installed model. The
    /// downloader handles both cases (it deletes the partial AND the
    /// final file).
    func cancelOrDelete(_ entryId: String) {
        guard let entry = entries.first(where: { $0.id == entryId }) else { return }
        if let dl = entry.downloader {
            dl.cancelAndDelete()
        } else {
            try? FileManager.default.removeItem(at: entry.installedURL)
            try? FileManager.default.removeItem(at: entry.installedURL.appendingPathExtension("partial"))
        }
        entry.downloader = nil
        entry.availability = computeAvailability(for: entry.model, at: entry.installedURL)
    }

    private func handleDownloadState(_ state: DownloadState, for entry: ModelEntry) {
        switch state {
        case .finished:
            entry.availability = .installed
            log.info("\(entry.id, privacy: .public) installed")
        case .failed:
            entry.availability = computeAvailability(for: entry.model, at: entry.installedURL)
        case .running, .verifying, .paused:
            entry.availability = .downloading
        case .idle:
            entry.availability = computeAvailability(for: entry.model, at: entry.installedURL)
        }
    }
}
