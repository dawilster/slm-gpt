import SwiftUI
import AppKit

// MARK: - Floating bottom-anchored dock window

/// Borderless NSPanel — needs a subclass so it can become key (text fields,
/// keyboard input) and main.
final class HaloDockPanel: NSPanel {
    override var canBecomeKey:  Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Borderless NSWindow — defaults to canBecomeKey=NO, which silently breaks
/// any text input or NSEvent local monitor inside the window (e.g. Settings,
/// the hotkey recorder). Subclass so it can take key.
final class HaloKeyableWindow: NSWindow {
    override var canBecomeKey:  Bool { true }
    override var canBecomeMain: Bool { true }
}

/// Bottom-anchored summoned chat dock. Borderless, transparent, floats above
/// other windows, joins all spaces, draggable by background, dismisses on click
/// outside (resign-key).
final class DockWindowController: NSObject, NSWindowDelegate {
    let panel: HaloDockPanel
    private let state: AppState
    private let host: NSHostingView<AnyView>

    init(state: AppState) {
        self.state = state

        let panel = HaloDockPanel(
            contentRect: NSRect(x: 0, y: 0, width: HaloMetrics.dockWidth, height: 200),
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.level = .floating
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true                // <- draggable
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.becomesKeyOnlyIfNeeded = false                    // text input focuses immediately
        panel.isReleasedWhenClosed = false
        panel.isMovable = true
        panel.hidesOnDeactivate = false

        self.panel = panel

        // SwiftUI host with state injected — view re-renders when state changes.
        let initialView = AnyView(DockHost().environment(state))
        self.host = NSHostingView(rootView: initialView)
        host.translatesAutoresizingMaskIntoConstraints = false

        super.init()

        panel.delegate = self

        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = .clear
        container.addSubview(host)
        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            host.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            host.topAnchor.constraint(equalTo: container.topAnchor),
            host.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        panel.contentView = container
    }

    func showAtBottomCenter() {
        refreshContent()
        let fittingSize = host.fittingSize
        guard let screen = NSScreen.main else {
            panel.setContentSize(fittingSize)
            panel.makeKeyAndOrderFront(nil)
            return
        }
        let frame = screen.visibleFrame
        let w = max(HaloMetrics.dockWidth, fittingSize.width)
        let h = max(60, fittingSize.height)
        let origin = NSPoint(x: frame.midX - w / 2, y: frame.minY + 28)
        panel.setFrame(NSRect(origin: origin, size: CGSize(width: w, height: h)),
                       display: true, animate: false)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    func dismiss() {
        panel.orderOut(nil)
    }

    func refreshContent() {
        host.rootView = AnyView(DockHost().environment(state))
    }

    // MARK: NSWindowDelegate — click outside dismisses.
    func windowDidResignKey(_ notification: Notification) {
        // Defer so any in-flight click on a child control completes first.
        DispatchQueue.main.async { [weak self] in self?.dismiss() }
    }
}

/// Hosted SwiftUI root that observes AppState and switches between dock
/// screens. Handles Escape-to-dismiss and Enter-to-send transitions.
private struct DockHost: View {
    @Environment(AppState.self) private var state

    var body: some View {
        Group {
            switch state.dockScreen {
            case .idle:     DockIdleView()
            case .thinking: DockThinkingView()
            case .shortcut: DockShortcutView()
            }
        }
        .onKeyPress(.escape) {
            // Reset to idle and dismiss the panel on escape.
            state.dockScreen = .idle
            state.menubarState = .idle
            NSApp.keyWindow?.orderOut(nil)
            return .handled
        }
    }
}

// MARK: - Auxiliary windows (onboarding, first-run, settings)

/// Borderless rounded window hosting any DockShell-styled content.
final class AuxiliaryWindowController: NSObject {
    private let window: HaloKeyableWindow

    init(title: String, content: AnyView, size: CGSize) {
        let window = HaloKeyableWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.isMovableByWindowBackground = true
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.title = title
        window.level = .normal
        window.isReleasedWhenClosed = false

        let host = NSHostingView(rootView: content.frame(width: HaloMetrics.dockWidth))
        host.translatesAutoresizingMaskIntoConstraints = false

        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = .clear
        container.addSubview(host)
        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            host.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            host.topAnchor.constraint(equalTo: container.topAnchor),
            host.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        window.contentView = container
        self.window = window
        super.init()
    }

    func show() {
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func close() {
        window.orderOut(nil)
    }
}
