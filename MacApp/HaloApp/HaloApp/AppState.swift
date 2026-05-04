import SwiftUI

enum HaloMenubarState: String, Equatable {
    case offline, idle, listening, thinking, loading
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
}
