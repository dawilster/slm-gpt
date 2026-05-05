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
    let sizeBytes: Int64        // sum of every file in the HF repo
    let ramRequiredMB: Int
    let context: Int
    /// HuggingFace repo id (e.g. "mlx-community/Qwen3.5-2B-6bit").
    /// We download every file in this repo at the pinned revision into
    /// our local models dir, then point SwiftLM at that directory.
    let huggingfaceRepo: String
    /// Pinned commit SHA. "main" is permitted but defeats the
    /// vetting promise — bumping a model = re-pinning to a real SHA.
    let huggingfaceRevision: String
    let minRamGB: Int
    // No isVisionModel field: serve.py auto-detects VLMs by
    // inspecting the model's config.json for a `vision_config` block,
    // so the catalog stays free of redundant-flag-vs-config drift.
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

    /// True if the entry id exists in the current catalog. Cheap helper
    /// used by AppDelegate to validate a persisted selectedModelId
    /// against catalog drift (entry removed across app upgrades).
    func has(id: String) -> Bool {
        entries.contains(where: { $0.id == id })
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
        // MLX models are *directories* (config.json + tokenizer.json +
        // model.safetensors* + ...), not single files. We mirror the
        // HF repo structure under <id>/ for clarity.
        modelsDirectory.appendingPathComponent(model.id, isDirectory: true)
    }

    private func computeAvailability(for model: CatalogModel, at dest: URL) -> EntryAvailability {
        if model.minRamGB > SystemInfo.totalRAMGB {
            return .ramBlocked(model.minRamGB)
        }
        // An installed MLX model needs at minimum: config.json,
        // tokenizer.json, and a safetensors file. If those are present
        // we trust it; per-file verification happens on download.
        let requiredFiles = ["config.json", "tokenizer.json"]
        let allRequired = requiredFiles.allSatisfy {
            FileManager.default.fileExists(atPath: dest.appendingPathComponent($0).path)
        }
        // safetensors may be sharded — accept any file matching .safetensors
        let hasSafetensors = (try? FileManager.default.contentsOfDirectory(atPath: dest.path))?
            .contains(where: { $0.hasSuffix(".safetensors") }) ?? false
        if allRequired && hasSafetensors {
            return .installed
        }
        return .available
    }

    // MARK: - Public actions

    /// Begin (or resume) downloading a model. Wires up a ModelDownloader
    /// for the HF repo at the pinned revision, downloading every file
    /// into the entry's directory.
    func startDownload(for entryId: String) {
        guard let entry = entries.first(where: { $0.id == entryId }) else { return }

        if entry.downloader == nil {
            let dl = ModelDownloader(
                modelId: entry.id,
                huggingfaceRepo: entry.model.huggingfaceRepo,
                huggingfaceRevision: entry.model.huggingfaceRevision,
                expectedTotalBytes: entry.model.sizeBytes,
                destinationDirectory: entry.installedURL
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

    /// Cancel an in-progress download or delete an installed model.
    /// MLX models live in a directory, so we recursively remove the
    /// whole tree (deletes both completed files and any partials).
    func cancelOrDelete(_ entryId: String) {
        guard let entry = entries.first(where: { $0.id == entryId }) else { return }
        entry.downloader?.cancel()
        try? FileManager.default.removeItem(at: entry.installedURL)
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
        case .running, .verifying:
            entry.availability = .downloading
        case .idle:
            entry.availability = computeAvailability(for: entry.model, at: entry.installedURL)
        }
    }
}
