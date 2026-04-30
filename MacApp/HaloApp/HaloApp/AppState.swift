import SwiftUI

enum HaloMenubarState: String, Equatable {
    case idle, listening, thinking, loading
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

@Observable
final class AppState {
    var menubarState: HaloMenubarState = .idle
    var dockScreen: DockScreen = .idle

    /// User-bindable hotkey, persisted to UserDefaults. Mutating it
    /// triggers re-registration via `onHotkeyChange`.
    var hotkey: Hotkey {
        didSet { persistHotkey(); onHotkeyChange?(hotkey) }
    }

    /// Set by AppDelegate so AppState can re-register the hotkey on change.
    var onHotkeyChange: ((Hotkey) -> Void)?

    init() {
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
