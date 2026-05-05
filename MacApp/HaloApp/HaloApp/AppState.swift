import SwiftUI

enum HaloMenubarState: String, Equatable {
    case offline, idle, listening, thinking, loading, error
}

/// A single, derived view of "what is the model doing right now". Used
/// by every status surface (menubar glyph, menubar panel hero, dock
/// ready strip) so they all agree. Built from `modelServerState`
/// (process lifecycle), `runtimeStatus` (harness HTTP health), and
/// `chat.status` (in-flight turn) — the three signals that, together,
/// describe the real state from the user's perspective.
struct ModelStatusSummary: Equatable {
    /// Glyph state for the menubar mark + dot color.
    let kind: HaloMenubarState
    /// Short headline ("Ready", "Loading qwen3.5-2b…", "Model crashed").
    let headline: String
    /// Optional second line of detail (e.g. crash reason). Nil keeps
    /// the UI to one line.
    let detail: String?
}

/// Where the brain (halo-runtime) gets its model from.
///
/// `bundled` is reserved for v8.5 — when llama-server is shipped inside
/// the app, this is the default and the user picks one of our vetted
/// models. Until then, only `external` is functional and the UI marks
/// `bundled` as preview/coming-soon.
enum EndpointMode: String, CaseIterable, Identifiable {
    case bundled, external
    var id: String { rawValue }
    var label: String {
        switch self {
        case .bundled:  return "Bundled model"
        case .external: return "My own endpoint"
        }
    }
}

enum DockScreen: String, CaseIterable, Identifiable {
    case idle, thinking, shortcut
    var id: String { rawValue }
    var label: String {
        switch self {
        case .idle:     return "Idle"
        case .thinking: return "Thinking"
        case .shortcut: return "Shortcut"
        }
    }
}

/// Singleton — both AppDelegate (at applicationDidFinishLaunching) and the
/// SwiftUI scenes (via @Environment) talk to the same instance, which avoids
/// a window-of-time at launch where each held different references.
@Observable
final class AppState {
    static let shared = AppState()

    var menubarState: HaloMenubarState = .idle
    var dockScreen: DockScreen = .idle

    /// Live conversation surfaced in the dock.
    let chat = ChatSession()

    /// Health probe of the local runtime daemon (model, context, online flag).
    var runtimeStatus: RuntimeStatus = .offline

    /// Lifecycle of the bundled runtime child process — distinct from
    /// `runtimeStatus`, which is just the HTTP health of whatever's
    /// listening on the port. `processState` answers "did *we* spawn it,
    /// and is it healthy from a process-management perspective?"
    var runtimeProcessState: RuntimeProcessState = .notStarted

    /// Lifecycle of the bundled llama-server child process. Distinct
    /// from `runtimeProcessState` (which tracks halo-runtime). Only
    /// meaningful in bundled mode — external mode leaves this at
    /// `.notStarted`.
    var modelServerState: ModelServerState = .notStarted

    /// Where the brain points for inference. Today only `external` is
    /// functional; `bundled` becomes live when v8.5 ships llama-server.
    /// Persisted to UserDefaults; mutating fires `onEndpointChange` so
    /// AppDelegate can restart the runtime with the new MODEL_BASE_URL.
    var endpointMode: EndpointMode = AppState.loadEndpointMode() {
        didSet {
            UserDefaults.standard.set(endpointMode.rawValue, forKey: AppState.endpointModeKey)
            onEndpointChange?()
        }
    }

    /// OpenAI-compatible base URL for `external` mode. Defaults to
    /// LM Studio's local server. Empty string is treated as "fall back to
    /// runtime default" rather than a hard error.
    var externalEndpointURL: String = AppState.loadExternalEndpoint() {
        didSet {
            UserDefaults.standard.set(externalEndpointURL, forKey: AppState.externalEndpointKey)
            // Don't restart on every keystroke — AppDelegate debounces via
            // the dedicated `applyEndpointChanges()` call.
        }
    }

    /// ID of the catalog entry the user picked for bundled inference.
    /// Drives ModelServer's `--model` arg. Nil until the user picks one
    /// (defaults to the first installed entry on bundled-mode boot).
    var selectedModelId: String? = AppState.loadSelectedModelId() {
        didSet {
            if let id = selectedModelId {
                UserDefaults.standard.set(id, forKey: AppState.selectedModelKey)
            } else {
                UserDefaults.standard.removeObject(forKey: AppState.selectedModelKey)
            }
            onSelectedModelChange?()
        }
    }

    /// Set by AppDelegate so AppState can trigger a ModelServer reload
    /// when the user picks a different bundled model from Settings.
    var onSelectedModelChange: (() -> Void)?

    /// Set by AppDelegate so AppState can trigger a runtime restart when
    /// the endpoint mode flips (URL changes are committed via an explicit
    /// "Apply" action so we don't restart on every keystroke).
    var onEndpointChange: (() -> Void)?

    /// User-bindable hotkey, persisted to UserDefaults. Mutating it
    /// triggers re-registration via `onHotkeyChange`.
    var hotkey: Hotkey {
        didSet { persistHotkey(); onHotkeyChange?(hotkey) }
    }

    /// True while the user is capturing a new hotkey in Settings or
    /// Onboarding — the global hotkey handler skips its action so the
    /// recorder's local NSEvent monitor wins the keypress.
    var isRecordingHotkey: Bool = false

    /// Set by AppDelegate so AppState can re-register the hotkey on change.
    var onHotkeyChange: ((Hotkey) -> Void)?

    private init() {
        self.hotkey = AppState.loadHotkey() ?? .default
    }

    var hasCompletedOnboarding: Bool {
        get { UserDefaults.standard.bool(forKey: "halo.onboardingComplete") }
        set { UserDefaults.standard.set(newValue, forKey: "halo.onboardingComplete") }
    }
    var hasCompletedFirstRun: Bool {
        get { UserDefaults.standard.bool(forKey: "halo.firstRunComplete") }
        set { UserDefaults.standard.set(newValue, forKey: "halo.firstRunComplete") }
    }

    func cycleDock() {
        let all = DockScreen.allCases
        let i = all.firstIndex(of: dockScreen) ?? 0
        dockScreen = all[(i + 1) % all.count]
        menubarState = (dockScreen == .thinking || dockScreen == .shortcut) ? .thinking : .idle
    }

    // MARK: - Hotkey persistence

    private static let hotkeyKey = "halo.hotkey"

    private static func loadHotkey() -> Hotkey? {
        guard let data = UserDefaults.standard.data(forKey: hotkeyKey) else { return nil }
        return try? JSONDecoder().decode(Hotkey.self, from: data)
    }

    private func persistHotkey() {
        guard let data = try? JSONEncoder().encode(hotkey) else { return }
        UserDefaults.standard.set(data, forKey: AppState.hotkeyKey)
    }

    // MARK: - Endpoint persistence

    static let endpointModeKey      = "halo.endpointMode"
    static let externalEndpointKey  = "halo.externalEndpoint"
    static let selectedModelKey     = "halo.selectedModelId"

    /// What halo-runtime defaulted to before we made it configurable —
    /// keeping the same value here means upgrading users see no change.
    static let defaultExternalEndpoint = "http://localhost:1234/v1"

    /// Where the bundled llama-server listens. Mirrors ModelServer.port.
    /// Hardcoded twice (here + ModelServer.swift) intentionally — this
    /// is read at AppState init before ModelServer.shared is available.
    static let bundledModelBaseURL = "http://127.0.0.1:1235/v1"

    private static func loadEndpointMode() -> EndpointMode {
        let raw = UserDefaults.standard.string(forKey: endpointModeKey) ?? EndpointMode.external.rawValue
        return EndpointMode(rawValue: raw) ?? .external
    }

    private static func loadExternalEndpoint() -> String {
        UserDefaults.standard.string(forKey: externalEndpointKey) ?? defaultExternalEndpoint
    }

    private static func loadSelectedModelId() -> String? {
        UserDefaults.standard.string(forKey: selectedModelKey)
    }

    /// Resolved endpoint URL the harness should talk to right now.
    /// Bundled mode points at the in-process llama-server; external
    /// points at whatever the user pasted.
    var resolvedModelBaseURL: String {
        switch endpointMode {
        case .bundled:  return AppState.bundledModelBaseURL
        case .external: return externalEndpointURL.isEmpty ? AppState.defaultExternalEndpoint : externalEndpointURL
        }
    }

    /// Single source of truth for "what's the model doing". Every
    /// status surface (menubar glyph, menubar panel hero, dock strip)
    /// reads this so they can never disagree.
    ///
    /// Priority order — what we'd say to the user, ranked by
    /// "would the user want to know this most?":
    ///   1. Crash    (something broke; the user needs to know now)
    ///   2. Loading  (in transition; explains why chat isn't ready)
    ///   3. Offline  (harness is down)
    ///   4. Thinking (chat turn in flight)
    ///   5. Ready    (everything is up)
    var modelStatus: ModelStatusSummary {
        // 1. Crash trumps everything — the user can't use anything,
        //    they need the failure surfaced.
        if case .crashed(let why) = modelServerState, endpointMode == .bundled {
            return ModelStatusSummary(kind: .error, headline: "Model unavailable", detail: why)
        }

        // 2. Mid-load — model server is spawning or loading weights.
        //    "Loading <id>…" so the user knows what's happening.
        if case .starting(let id) = modelServerState, endpointMode == .bundled {
            return ModelStatusSummary(kind: .loading, headline: "Loading \(id)…", detail: nil)
        }

        // 3. Harness is down (no /v1/health response). Distinct from
        //    "no model selected yet" — that's not an error, it just
        //    means there's nothing to do until the user picks one.
        if !runtimeStatus.connected {
            // Bundled mode + nothing running = boot-in-progress
            // rather than a real fault. Silent during the first
            // ~second so the menubar doesn't flash "offline" before
            // the harness binds the port.
            if endpointMode == .bundled,
               case .notStarted = modelServerState {
                return ModelStatusSummary(kind: .loading, headline: "Starting…", detail: nil)
            }
            return ModelStatusSummary(
                kind: .offline,
                headline: "Offline",
                detail: endpointMode == .external
                    ? "Endpoint \(externalEndpointURL) unreachable"
                    : "Runtime not responding"
            )
        }

        // 4. Chat in flight — generation is happening.
        if chat.status == .thinking {
            return ModelStatusSummary(kind: .thinking, headline: "Thinking…", detail: nil)
        }

        // 5. Default — everything up, idle.
        return ModelStatusSummary(kind: .idle, headline: "Ready", detail: nil)
    }
}
