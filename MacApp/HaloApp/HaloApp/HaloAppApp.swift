import SwiftUI
import AppKit

@main
struct HaloAppApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    // Singleton — same instance the AppDelegate registers the hotkey against.
    @State private var state = AppState.shared

    var body: some Scene {
        // No SwiftUI scenes — the menubar surface is a custom NSStatusItem
        // (StatusBarController) so we can route left-click vs right-click
        // independently. Auxiliary windows are created by AppDelegate.
        Settings { EmptyView() }
    }
}

// MARK: - App delegate — owns the floating windows + global hotkey

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusBar: StatusBarController?
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

        // Custom NSStatusItem-based menubar surface. Handles left-click
        // (dropdown) + right-click (Quit menu) independently.
        statusBar = StatusBarController(
            state: state,
            onSummon:    { [weak self] in self?.toggleDock() },
            onSettings:  { [weak self] in self?.showSettings() },
            onRunSetup:  { [weak self] in self?.runSetup() },
            onCycleDock: { [weak self] in
                state.cycleDock()
                self?.refreshDockIfVisible()
            },
            onOpenSession: { [weak self] id in self?.openSession(id) }
        )

        // Banner notifications when replies land while the dock is hidden.
        Notifier.shared.bootstrap()

        // Spawn (or attach to) the bundled Bun runtime *before* the health
        // probe starts — so the very first probe has a real chance of
        // succeeding instead of flashing "offline" for a beat.
        RuntimeServer.shared.onStateChange = { newState in
            AppState.shared.runtimeProcessState = newState
        }
        AppState.shared.runtimeProcessState = RuntimeServer.shared.state

        // Boot the orchestrated stack: in bundled mode we start the
        // llama-server first and wait for it to come up, *then* the
        // harness, so the harness's first request has a real model
        // behind it. In external mode we just spawn the harness and
        // trust the user's endpoint is reachable.
        Task { await self.bootInferenceStack() }

        // Endpoint mode change → tear down ModelServer if we left
        // bundled, spin it up if we entered. Then restart the harness
        // with the new MODEL_BASE_URL. URL-field edits are debounced
        // via the explicit applyEndpointChanges() call.
        AppState.shared.onEndpointChange = { [weak self] in
            self?.applyEndpointChanges()
        }

        // Selected-model change in bundled mode → restart ModelServer
        // pointed at the new GGUF.
        AppState.shared.onSelectedModelChange = { [weak self] in
            self?.applySelectedModelChange()
        }

        // Periodic runtime health probe — drives the "Ready / Offline" status
        // in the dock and the menubar dropdown.
        startHealthProbe()

        // First-launch flow.
        if !state.hasCompletedOnboarding {
            showOnboarding()
        } else if !state.hasCompletedFirstRun {
            showFirstRun()
        }
    }

    private var healthTimer: Timer?

    private func startHealthProbe() {
        Task { await self.probeOnce() }
        // .common mode → fires through menu tracking. The default mode pauses
        // while the menubar popover is open, which is exactly when the user
        // is most likely to look at the connection state.
        let timer = Timer(timeInterval: 3.0, repeats: true) { _ in
            Task { @MainActor in await AppDelegate.shared?.probeOnce() }
        }
        RunLoop.main.add(timer, forMode: .common)
        healthTimer = timer
    }

    @MainActor
    private func probeOnce() async {
        do {
            let h = try await RuntimeClient.shared.health()
            let next = RuntimeStatus(
                connected:    true,
                modelLabel:   h.model,
                contextHint:  h.contextLimit.map { "\($0/1024)K ctx" },
                contextLimit: h.contextLimit,
                sizeBytes:    h.sizeBytes,
                tokensPerSec: h.tokensPerSec,
                quantization: h.quantization,
                paramsString: h.paramsString
            )
            if AppState.shared.runtimeStatus != next {
                AppState.shared.runtimeStatus = next
            }
        } catch {
            // Always set on transition to offline — prior code only set it
            // when previously connected, which was correct but subtle.
            if AppState.shared.runtimeStatus.connected {
                AppState.shared.runtimeStatus = .offline
            }
        }
    }

    static var shared: AppDelegate? {
        NSApp.delegate as? AppDelegate
    }

    // MARK: Runtime teardown

    /// Tear down both the bundled runtime and llama-server when the app
    /// quits. Order matters: harness first (it depends on the model
    /// server), then llama-server. Each does SIGTERM-then-SIGKILL with
    /// its own grace window.
    func applicationWillTerminate(_ notification: Notification) {
        RuntimeServer.shared.stop()
        ModelServer.shared.stop()
    }

    // MARK: - Inference stack orchestration

    /// Boot the inference stack in the right order based on current
    /// endpoint mode. In bundled mode we wait for llama-server's health
    /// before starting the harness — otherwise the harness's first
    /// model-discovery probe races the model load and reports offline.
    private func bootInferenceStack() async {
        switch AppState.shared.endpointMode {
        case .bundled:
            await startBundledModelIfPossible()
            await RuntimeServer.shared.start()
        case .external:
            // No model server to manage — harness talks straight to the
            // user's endpoint.
            await RuntimeServer.shared.start()
        }
    }

    /// Pick a model and start llama-server. Falls back to first
    /// installed entry if the user hasn't picked one (a fresh-install
    /// state: bundled mode selected in onboarding, no explicit pick).
    /// If nothing is installed, we leave llama-server stopped — the UI
    /// surfaces the empty state.
    private func startBundledModelIfPossible() async {
        let catalog = ModelCatalog.shared
        let modelId: String? = AppState.shared.selectedModelId
            ?? catalog.entries.first(where: {
                if case .installed = $0.availability { return true }
                return false
            })?.id

        guard let modelId else {
            ModelServer.shared.onStateChange?(.crashed(reason: "no installed model"))
            return
        }
        await ModelServer.shared.start(modelId: modelId)
    }

    /// User flipped the endpoint mode (or hit Apply on a new URL).
    /// Stop/start the ModelServer to match, then restart the harness
    /// with the new MODEL_BASE_URL.
    func applyEndpointChanges() {
        Task {
            switch AppState.shared.endpointMode {
            case .bundled:
                await startBundledModelIfPossible()
            case .external:
                ModelServer.shared.stop()
            }
            await RuntimeServer.shared.restart()
        }
    }

    /// User picked a different bundled model from Settings. Stop the
    /// current llama-server, start it with the new model. Harness
    /// stays up — its next request reconnects automatically since
    /// MODEL_BASE_URL hasn't changed.
    func applySelectedModelChange() {
        guard AppState.shared.endpointMode == .bundled else { return }
        Task { await self.startBundledModelIfPossible() }
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
        // Reset the chat if it's been idle long enough — so a new summon
        // after a coffee break gives the user a clean canvas.
        AppState.shared.chat.markSummoned()
        if dockController == nil {
            dockController = DockWindowController(state: AppState.shared)
        }
        dockController?.summon()
    }

    /// Whether the floating chat dock is currently visible on screen.
    /// Read by ChatSession to decide whether a completed turn should
    /// surface as a banner notification or just stay in the open window.
    var isDockVisible: Bool {
        dockController?.panel.isVisible ?? false
    }

    /// Load an existing conversation by id and reopen the dock to show it.
    /// Bypasses ChatSession.markSummoned so we don't accidentally idle-reset
    /// the conversation we're trying to load.
    func openSession(_ id: String) {
        Task { @MainActor in
            do {
                let detail = try await RuntimeClient.shared.session(id: id)
                AppState.shared.chat.load(detail)
                if dockController == nil {
                    dockController = DockWindowController(state: AppState.shared)
                }
                dockController?.summon()
            } catch {
                // If load fails, fall back to a plain summon — better than
                // doing nothing.
                showDock()
            }
        }
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
                    AppState.shared.hasCompletedFirstRun = true  // FirstRun is reserved for v8.5 (real model download); skip in A+B
                    close()
                    self?.showDock()
                },
                onTryNow: { [weak self] in
                    AppState.shared.hasCompletedOnboarding = true
                    AppState.shared.hasCompletedFirstRun = true
                    close()
                    self?.showDock()
                },
                onClose: close
            )
            onboardingController = AuxiliaryWindowController(
                title: "Welcome to Milo",
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
                    // Setup is finished — drop the user straight into a fresh
                    // chat so they don't have to find the menubar themselves.
                    self?.showDock()
                },
                onClose: close,
                onChooseAnother: { [weak self] in
                    close()
                    self?.showSettings()
                }
            )
            firstRunController = AuxiliaryWindowController(
                title: "Setup Milo",
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
                title: "Milo Settings",
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
    static func menubarImage(state: HaloMenubarState, phaseDegrees: Double = 0) -> NSImage {
        let renderer = ImageRenderer(content:
            HaloMark(size: 18, state: state, color: .white, phaseDegrees: phaseDegrees)
                .frame(width: 18, height: 18)
        )
        renderer.scale = NSScreen.main?.backingScaleFactor ?? 2.0
        let img = renderer.nsImage ?? NSImage(size: NSSize(width: 18, height: 18))
        img.isTemplate = false
        return img
    }
}
