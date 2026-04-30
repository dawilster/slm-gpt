import SwiftUI
import AppKit

@main
struct HaloAppApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    // Singleton — same instance the AppDelegate registers the hotkey against.
    @State private var state = AppState.shared

    var body: some Scene {
        MenuBarExtra {
            MenubarPanelView(
                onSummon:    { appDelegate.toggleDock() },
                onSettings:  { appDelegate.showSettings() },
                onRunSetup:  { appDelegate.runSetup() },
                onCycleDock: {
                    state.cycleDock()
                    appDelegate.refreshDockIfVisible()
                }
            )
            .environment(state)
        } label: {
            // SwiftUI animations don't drive a view embedded in MenuBarExtra's
            // label, so the glyph is snapshotted per state.
            Image(nsImage: HaloMark.menubarImage(state: state.menubarState))
        }
        .menuBarExtraStyle(.window)
    }
}

// MARK: - App delegate — owns the floating windows + global hotkey

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var dockController: DockWindowController?
    private var onboardingController: AuxiliaryWindowController?
    private var firstRunController:   AuxiliaryWindowController?
    private var settingsController:   AuxiliaryWindowController?

    private let hotkeyManager = HotkeyManager()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Menubar accessory — no Dock icon, no main window.
        NSApp.setActivationPolicy(.accessory)

        let state = AppState.shared
        state.onHotkeyChange = { [weak self] new in self?.registerHotkey(new) }
        registerHotkey(state.hotkey)

        // First-launch flow.
        if !state.hasCompletedOnboarding {
            showOnboarding()
        } else if !state.hasCompletedFirstRun {
            showFirstRun()
        }
    }

    // MARK: Hotkey

    private func registerHotkey(_ hotkey: Hotkey) {
        hotkeyManager.register(hotkey) { [weak self] in
            // Skip the dock toggle if the user is recording a new hotkey —
            // the recorder's local NSEvent monitor needs to win the keypress.
            guard !AppState.shared.isRecordingHotkey else { return }
            self?.toggleDock()
        }
    }

    /// Hotkey + Summon button behavior — visible dock dismisses, hidden summons.
    func toggleDock() {
        if let dock = dockController, dock.panel.isVisible {
            dock.dismiss()
        } else {
            showDock()
        }
    }

    // MARK: Dock (bottom-anchored summoned chat)

    func showDock() {
        if dockController == nil {
            dockController = DockWindowController(state: AppState.shared)
        }
        dockController?.summon()
    }

    func refreshDockIfVisible() {
        dockController?.refreshContent()
    }

    // MARK: Setup flow

    func runSetup() {
        AppState.shared.hasCompletedOnboarding = false
        AppState.shared.hasCompletedFirstRun = false
        showOnboarding()
    }

    func showOnboarding() {
        if onboardingController == nil {
            let close: () -> Void = { [weak self] in
                self?.onboardingController?.close()
                self?.onboardingController = nil
            }
            let view = OnboardingView(
                onContinue: { [weak self] in
                    AppState.shared.hasCompletedOnboarding = true
                    close()
                    self?.showFirstRun()
                },
                onTryNow: { [weak self] in
                    AppState.shared.hasCompletedOnboarding = true
                    close()
                    self?.showDock()
                },
                onClose: close
            )
            onboardingController = AuxiliaryWindowController(
                title: "Welcome to Halo",
                content: AnyView(view.environment(AppState.shared)),
                size: CGSize(width: HaloMetrics.dockWidth, height: 280)
            )
        }
        onboardingController?.show()
    }

    func showFirstRun() {
        if firstRunController == nil {
            let close: () -> Void = { [weak self] in
                self?.firstRunController?.close()
                self?.firstRunController = nil
            }
            let view = FirstRunView(
                onDone: { [weak self] in
                    AppState.shared.hasCompletedFirstRun = true
                    close()
                    _ = self
                },
                onClose: close
            )
            firstRunController = AuxiliaryWindowController(
                title: "Setup Halo",
                content: AnyView(view.environment(AppState.shared)),
                size: CGSize(width: HaloMetrics.dockWidth, height: 220)
            )
        }
        firstRunController?.show()
    }

    func showSettings() {
        if settingsController == nil {
            let close: () -> Void = { [weak self] in
                self?.settingsController?.close()
                self?.settingsController = nil
            }
            let view = SettingsView(onClose: close)
            settingsController = AuxiliaryWindowController(
                title: "Halo Settings",
                content: AnyView(view.environment(AppState.shared)),
                size: CGSize(width: HaloMetrics.dockWidth, height: 480)
            )
        }
        settingsController?.show()
    }
}

// MARK: - Static menubar glyph

extension HaloMark {
    @MainActor
    static func menubarImage(state: HaloMenubarState) -> NSImage {
        let renderer = ImageRenderer(content:
            HaloMark(size: 18, state: state, color: .white)
                .frame(width: 18, height: 18)
        )
        renderer.scale = NSScreen.main?.backingScaleFactor ?? 2.0
        let img = renderer.nsImage ?? NSImage(size: NSSize(width: 18, height: 18))
        img.isTemplate = false
        return img
    }
}
