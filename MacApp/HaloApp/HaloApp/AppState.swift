import SwiftUI

enum HaloMenubarState: String, Equatable {
    case offline, idle, listening, thinking, loading
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

    /// What halo-runtime defaulted to before we made it configurable —
    /// keeping the same value here means upgrading users see no change.
    static let defaultExternalEndpoint = "http://localhost:1234/v1"

    private static func loadEndpointMode() -> EndpointMode {
        let raw = UserDefaults.standard.string(forKey: endpointModeKey) ?? EndpointMode.external.rawValue
        return EndpointMode(rawValue: raw) ?? .external
    }

    private static func loadExternalEndpoint() -> String {
        UserDefaults.standard.string(forKey: externalEndpointKey) ?? defaultExternalEndpoint
    }

    /// Resolved endpoint URL based on current mode. Until v8.5 ships
    /// llama-server, `bundled` falls back to whatever external is set to
    /// — the UI prevents the user from selecting bundled if it's not
    /// supported, so this fallback is defense-in-depth, not policy.
    var resolvedModelBaseURL: String {
        switch endpointMode {
        case .bundled:  return AppState.defaultExternalEndpoint  // placeholder — real bundled URL lands at v8.5
        case .external: return externalEndpointURL.isEmpty ? AppState.defaultExternalEndpoint : externalEndpointURL
        }
    }
}
