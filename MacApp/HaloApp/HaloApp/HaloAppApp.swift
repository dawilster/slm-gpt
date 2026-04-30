import SwiftUI
import AppKit

@main
struct HaloAppApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    // Shared between the menubar panel and the floating windows.
    @State private var state = AppState()

    var body: some Scene {
        MenuBarExtra {
            MenubarPanelView(
                onSummon:    { appDelegate.showDock() },
                onSettings:  { appDelegate.showSettings() },
                onRunSetup:  { appDelegate.runSetup() },
                onCycleDock: {
                    state.cycleDock()
                    appDelegate.refreshDockIfVisible()
                }
            )
            .environment(state)
            .onAppear {
                appDelegate.state = state
            }
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
    var state: AppState? {
        didSet { wireHotkeyChanges() }
    }

    private var dockController: DockWindowController?
    private var onboardingController: AuxiliaryWindowController?
    private var firstRunController:   AuxiliaryWindowController?
    private var settingsController:   AuxiliaryWindowController?

    private let hotkeyManager = HotkeyManager()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Menubar accessory — no Dock icon, no main window.
        NSApp.setActivationPolicy(.accessory)

        DispatchQueue.main.async { [weak self] in
            guard let self, let state = self.state else { return }

            // Register global hotkey.
            self.registerHotkey(state.hotkey)

            // First launch flow.
            if !state.hasCompletedOnboarding {
                self.showOnboarding()
            } else if !state.hasCompletedFirstRun {
                self.showFirstRun()
            }
        }
    }

    // MARK: Hotkey

    private func wireHotkeyChanges() {
        state?.onHotkeyChange = { [weak self] new in self?.registerHotkey(new) }
    }

    private func registerHotkey(_ hotkey: Hotkey) {
        hotkeyManager.register(hotkey) { [weak self] in self?.toggleDock() }
    }

    /// Hotkey behavior — visible dock dismisses, hidden dock summons.
    func toggleDock() {
        if let dock = dockController, dock.panel.isVisible {
            dock.dismiss()
        } else {
            showDock()
        }
    }

    // MARK: Dock (bottom-anchored summoned chat)

    func showDock() {
        guard let state else { return }
        if dockController == nil {
            dockController = DockWindowController(state: state)
        }
        dockController?.showAtBottomCenter()
    }

    func refreshDockIfVisible() {
        dockController?.refreshContent()
    }

    // MARK: Setup flow

    func runSetup() {
        state?.hasCompletedOnboarding = false
        state?.hasCompletedFirstRun = false
        showOnboarding()
    }

    func showOnboarding() {
        guard let state else { return }
        if onboardingController == nil {
            let view = OnboardingView(
                onContinue: { [weak self] in
                    self?.state?.hasCompletedOnboarding = true
                    self?.onboardingController?.close()
                    self?.onboardingController = nil
                    self?.showFirstRun()
                },
                onTryNow: { [weak self] in
                    self?.state?.hasCompletedOnboarding = true
                    self?.onboardingController?.close()
                    self?.onboardingController = nil
                    self?.showDock()
                }
            )
            onboardingController = AuxiliaryWindowController(
                title: "Welcome to Halo",
                content: AnyView(view.environment(state)),
                size: CGSize(width: HaloMetrics.dockWidth, height: 280)
            )
        }
        onboardingController?.show()
    }

    func showFirstRun() {
        guard let state else { return }
        if firstRunController == nil {
            let view = FirstRunView(onDone: { [weak self] in
                self?.state?.hasCompletedFirstRun = true
                self?.firstRunController?.close()
                self?.firstRunController = nil
            })
            firstRunController = AuxiliaryWindowController(
                title: "Setup Halo",
                content: AnyView(view.environment(state)),
                size: CGSize(width: HaloMetrics.dockWidth, height: 220)
            )
        }
        firstRunController?.show()
    }

    func showSettings() {
        guard let state else { return }
        if settingsController == nil {
            settingsController = AuxiliaryWindowController(
                title: "Halo Settings",
                content: AnyView(SettingsView().environment(state)),
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
