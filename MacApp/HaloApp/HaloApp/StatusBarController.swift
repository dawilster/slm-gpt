import AppKit
import SwiftUI
import Observation

/// Custom NSStatusItem-based menubar controller. Replaces SwiftUI's
/// MenuBarExtra so we can route left-click → custom dropdown panel and
/// right-click → NSMenu with Quit, in the way macOS users expect.
/// Borderless popover panel for the menubar dropdown. Needs the same
/// canBecomeKey override as HaloDockPanel so click-outside actually
/// resigns key (and our dismiss handler can fire).
private final class StatusPanel: NSPanel {
    override var canBecomeKey:  Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class StatusBarController: NSObject, NSWindowDelegate {
    private let statusItem: NSStatusItem
    private let panel: StatusPanel
    private let host: NSHostingView<AnyView>
    private let state: AppState

    /// Drives the rotating-arc animation for `.thinking` / `.loading` —
    /// SwiftUI's `repeatForever` doesn't survive `ImageRenderer`, so we
    /// re-rasterize the glyph ourselves at ~10Hz with an advancing phase.
    private var animationTimer: Timer?
    private var animationStart: Date?

    private let onSummon:      () -> Void
    private let onSettings:    () -> Void
    private let onRunSetup:    () -> Void
    private let onCycleDock:   () -> Void
    private let onOpenSession: (String) -> Void

    init(
        state: AppState,
        onSummon:      @escaping () -> Void,
        onSettings:    @escaping () -> Void,
        onRunSetup:    @escaping () -> Void,
        onCycleDock:   @escaping () -> Void,
        onOpenSession: @escaping (String) -> Void
    ) {
        self.state         = state
        self.onSummon      = onSummon
        self.onSettings    = onSettings
        self.onRunSetup    = onRunSetup
        self.onCycleDock   = onCycleDock
        self.onOpenSession = onOpenSession

        // Status item
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        // Borderless panel — same visual style as the dock's NSPanel.
        let initialSize = NSSize(width: HaloMetrics.panelWidth, height: 460)
        panel = StatusPanel(
            contentRect: NSRect(origin: .zero, size: initialSize),
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.level = .statusBar
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.becomesKeyOnlyIfNeeded = false
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false

        // Initialize host with an empty placeholder; we attach the real
        // SwiftUI view *after* super.init() because the action closures
        // capture self for dismiss().
        host = NSHostingView(rootView: AnyView(EmptyView()))
        host.translatesAutoresizingMaskIntoConstraints = false

        super.init()
        panel.delegate = self

        // Now safe to capture self in the action closures.
        let panelView = MenubarPanelView(
            onSummon:      { [weak self] in self?.dismiss(); onSummon() },
            onSettings:    { [weak self] in self?.dismiss(); onSettings() },
            onRunSetup:    { [weak self] in self?.dismiss(); onRunSetup() },
            onCycleDock:   { [weak self] in self?.dismiss(); onCycleDock() },
            onOpenSession: { [weak self] id in self?.dismiss(); onOpenSession(id) }
        )
        .environment(state)
        .frame(width: HaloMetrics.panelWidth)
        host.rootView = AnyView(panelView)

        // Mount the host inside a layer-backed container that clips to a
        // rounded rect — same trick used by DockWindowController so the OS
        // shadow follows the panel's visible shape rather than the rectangle.
        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = .clear
        container.layer?.cornerRadius = HaloMetrics.panelCornerRadius
        container.layer?.cornerCurve = .continuous
        container.layer?.masksToBounds = true
        container.addSubview(host)
        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            host.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            host.topAnchor.constraint(equalTo: container.topAnchor),
            host.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        panel.contentView = container

        // Status item button: handle both left- and right-click via a single
        // action that dispatches on NSApp.currentEvent.type.
        if let button = statusItem.button {
            button.target = self
            button.action = #selector(handleClick(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        refreshIcon()
        observe()
    }

    deinit {
        animationTimer?.invalidate()
    }

    // MARK: - Click dispatch

    @objc private func handleClick(_ sender: NSStatusBarButton) {
        let kind = NSApp.currentEvent?.type ?? .leftMouseUp
        if kind == .rightMouseUp || (NSApp.currentEvent?.modifierFlags.contains(.control) ?? false) {
            showRightClickMenu()
        } else {
            togglePanel()
        }
    }

    // MARK: - Right-click menu

    private func showRightClickMenu() {
        let menu = NSMenu()

        let summon = NSMenuItem(title: "Summon Milo", action: #selector(menuSummon), keyEquivalent: "")
        summon.target = self
        menu.addItem(summon)

        let settings = NSMenuItem(title: "Settings…", action: #selector(menuSettings), keyEquivalent: ",")
        settings.target = self
        menu.addItem(settings)

        let setup = NSMenuItem(title: "Run setup again", action: #selector(menuRunSetup), keyEquivalent: "")
        setup.target = self
        menu.addItem(setup)

        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit Milo", action: #selector(NSApp.terminate(_:)), keyEquivalent: "q")
        quit.target = NSApp
        menu.addItem(quit)

        // Show the menu under the status item, then immediately clear the
        // assignment so the next left-click stays our custom action.
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    @objc private func menuSummon()    { dismiss(); onSummon() }
    @objc private func menuSettings()  { dismiss(); onSettings() }
    @objc private func menuRunSetup()  { dismiss(); onRunSetup() }

    // MARK: - Dropdown panel

    private func togglePanel() {
        if panel.isVisible {
            dismiss()
        } else {
            present()
        }
    }

    private func present() {
        guard let button = statusItem.button,
              let buttonWindow = button.window else { return }

        // The SwiftUI panel view stays mounted for the app's lifetime, so
        // its `.task` only runs once. Nudge it to reload recents now.
        NotificationCenter.default.post(name: .haloMenubarPanelWillPresent, object: nil)

        let fittingHeight = max(host.fittingSize.height, 200)
        panel.setContentSize(NSSize(width: HaloMetrics.panelWidth, height: fittingHeight))

        let buttonFrameInScreen = buttonWindow.convertToScreen(button.frame)
        // Anchor the panel under the status item, right-aligned to the
        // button so it doesn't drift off-screen on narrow displays.
        let origin = NSPoint(
            x: min(
                buttonFrameInScreen.midX - panel.frame.width / 2,
                (NSScreen.main?.visibleFrame.maxX ?? buttonFrameInScreen.maxX) - panel.frame.width - 8
            ),
            y: buttonFrameInScreen.minY - panel.frame.height - 4
        )
        panel.setFrameOrigin(origin)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    func dismiss() {
        if panel.isVisible { panel.orderOut(nil) }
    }

    // NSWindowDelegate — click outside dismisses (matches MenuBarExtra UX).
    func windowDidResignKey(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in self?.dismiss() }
    }

    // MARK: - Icon

    /// Combine connectivity, chat status, and explicit menubar state into a
    /// single glyph state. Offline trumps everything else — the runtime
    /// being down is the most important fact at a glance — followed by an
    /// in-flight chat turn, then any caller-set state.
    private var derivedState: HaloMenubarState {
        if !state.runtimeStatus.connected { return .offline }
        if state.chat.status == .thinking { return .thinking }
        return state.menubarState
    }

    /// Period (seconds) for one full rotation of the dashed arc.
    private static let thinkingPeriod: TimeInterval = 2.4
    private static let loadingPeriod:  TimeInterval = 1.2

    private func refreshIcon() {
        let s = derivedState
        let phase: Double = {
            guard let start = animationStart else { return 0 }
            let elapsed = Date().timeIntervalSince(start)
            switch s {
            case .thinking:
                return elapsed.truncatingRemainder(dividingBy: Self.thinkingPeriod)
                    / Self.thinkingPeriod * 360
            case .loading:
                return elapsed.truncatingRemainder(dividingBy: Self.loadingPeriod)
                    / Self.loadingPeriod * 360
            default:
                return 0
            }
        }()
        statusItem.button?.image = HaloMark.menubarImage(state: s, phaseDegrees: phase)
        syncAnimationTimer(for: s)
    }

    private func syncAnimationTimer(for s: HaloMenubarState) {
        let needsAnim = (s == .thinking || s == .loading)
        if needsAnim, animationTimer == nil {
            animationStart = Date()
            // ~10 fps. Tolerance lets the runloop coalesce ticks when the
            // app is otherwise idle, so we're not pinning the CPU.
            let t = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.refreshIcon() }
            }
            t.tolerance = 0.02
            RunLoop.main.add(t, forMode: .common)
            animationTimer = t
        } else if !needsAnim, animationTimer != nil {
            animationTimer?.invalidate()
            animationTimer = nil
            animationStart = nil
        }
    }

    /// Re-render the glyph whenever the menubar state OR the runtime
    /// connectivity changes. `withObservationTracking` only fires once per
    /// registration, so we re-arm after each callback.
    private func observe() {
        withObservationTracking {
            _ = state.menubarState
            _ = state.runtimeStatus
            _ = state.chat.status
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.refreshIcon()
                self.observe()
            }
        }
    }
}
