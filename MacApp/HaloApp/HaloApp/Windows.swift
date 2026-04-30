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
/// outside. Position is persisted across summons after the user moves it.
final class DockWindowController: NSObject, NSWindowDelegate {
    let panel: HaloDockPanel
    private let state: AppState
    private let host: NSHostingView<AnyView>

    /// UserDefaults key for the dragged position.
    private static let originKey = "halo.dock.origin"

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
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.becomesKeyOnlyIfNeeded = false
        panel.isReleasedWhenClosed = false
        panel.isMovable = true
        panel.hidesOnDeactivate = false

        self.panel = panel

        // Empty placeholder until super.init unlocks self-capture.
        self.host = NSHostingView(rootView: AnyView(EmptyView()))
        host.translatesAutoresizingMaskIntoConstraints = false

        super.init()

        // Now safe to capture self in the size callback.
        let view = DockHost(onContentHeightChange: { [weak self] h in
            self?.contentHeightChanged(h)
        })
        .environment(state)
        host.rootView = AnyView(view)

        panel.delegate = self

        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = .clear
        // Clip at the OS compositor so NSVisualEffectView's stroke/edge can't
        // leak past the rounded SwiftUI shape.
        container.layer?.cornerRadius = HaloMetrics.dockCornerRadius
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
    }

    /// Show — at the saved origin if present, otherwise centered above the dock.
    func summon() {
        refreshContent()
        let fittingSize = host.fittingSize
        let w = max(HaloMetrics.dockWidth, fittingSize.width)
        let h = max(60, fittingSize.height)

        let origin: NSPoint = {
            if let saved = DockWindowController.loadOrigin(),
               DockWindowController.originIsOnScreen(saved, size: CGSize(width: w, height: h)) {
                return saved
            }
            guard let screen = NSScreen.main else { return .zero }
            let frame = screen.visibleFrame
            return NSPoint(x: frame.midX - w / 2, y: frame.minY + 28)
        }()

        panel.setFrame(NSRect(origin: origin, size: CGSize(width: w, height: h)),
                       display: true, animate: false)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    func dismiss() {
        panel.orderOut(nil)
    }

    func refreshContent() {
        let view = DockHost(onContentHeightChange: { [weak self] h in
            self?.contentHeightChanged(h)
        })
        .environment(state)
        host.rootView = AnyView(view)
    }

    /// Called by the SwiftUI host whenever its intrinsic height changes.
    /// Resizes the panel so the dock grows with the conversation, anchored
    /// to the bottom edge so the input row stays put as messages pile up.
    private func contentHeightChanged(_ height: CGFloat) {
        guard panel.isVisible, height > 0 else { return }
        let screenCap = (NSScreen.main?.visibleFrame.height ?? 800) * 0.75
        let target = min(max(60, height), screenCap)

        let oldFrame = panel.frame
        if abs(target - oldFrame.height) < 1 { return }

        // Keep bottom edge fixed (grow upward).
        let newFrame = NSRect(
            x: oldFrame.minX,
            y: oldFrame.minY,
            width: oldFrame.width,
            height: target
        )
        panel.setFrame(newFrame, display: true, animate: false)
    }

    // MARK: NSWindowDelegate

    /// Click outside dismisses.
    func windowDidResignKey(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in self?.dismiss() }
    }

    /// User dragged the dock — remember the new origin so the next summon
    /// reuses it.
    func windowDidMove(_ notification: Notification) {
        DockWindowController.saveOrigin(panel.frame.origin)
    }

    // MARK: - Position persistence

    private static func saveOrigin(_ origin: NSPoint) {
        UserDefaults.standard.set([origin.x, origin.y], forKey: originKey)
    }

    private static func loadOrigin() -> NSPoint? {
        guard let arr = UserDefaults.standard.array(forKey: originKey) as? [Double],
              arr.count == 2 else { return nil }
        return NSPoint(x: arr[0], y: arr[1])
    }

    /// Discard a saved origin if the screen layout has changed and it would
    /// land off-screen (external display unplugged, etc.).
    private static func originIsOnScreen(_ origin: NSPoint, size: CGSize) -> Bool {
        let rect = NSRect(origin: origin, size: size)
        return NSScreen.screens.contains { $0.visibleFrame.intersects(rect) }
    }
}

/// Hosted SwiftUI root that observes AppState and renders the dock chat.
/// `.shortcut` is kept as a static demo until the runtime exposes
/// shortcut/multi-step traces in the chat itself.
private struct DockHost: View {
    @Environment(AppState.self) private var state
    /// Called whenever the SwiftUI content's intrinsic height changes —
    /// the controller resizes the NSPanel to match (anchored from the
    /// bottom) so the chat grows upward as messages stream in.
    var onContentHeightChange: (CGFloat) -> Void = { _ in }

    var body: some View {
        Group {
            switch state.dockScreen {
            case .idle, .thinking:
                DockChatView()
                    .environment(\.runtimeStatus, state.runtimeStatus)
            case .shortcut:
                DockShortcutView()
            }
        }
        .background(
            GeometryReader { geo in
                Color.clear
                    .onAppear { onContentHeightChange(geo.size.height) }
                    .onChange(of: geo.size.height) { _, new in
                        onContentHeightChange(new)
                    }
            }
        )
        .onKeyPress(.escape) {
            // If a turn is mid-flight, abort it and stay on the dock.
            if state.chat.status == .thinking {
                state.chat.cancel()
                return .handled
            }
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
        window.level = .floating       // accessory apps need this so windows
                                       // don't end up behind other apps
        window.isReleasedWhenClosed = false

        let host = NSHostingView(rootView: content.frame(width: HaloMetrics.dockWidth))
        host.translatesAutoresizingMaskIntoConstraints = false

        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = .clear
        container.layer?.cornerRadius = HaloMetrics.dockCornerRadius
        container.layer?.cornerCurve = .continuous
        container.layer?.masksToBounds = true
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
        // Activate first so the window comes forward in an accessory app.
        NSApp.activate(ignoringOtherApps: true)
        window.center()
        window.orderFrontRegardless()
        window.makeKeyAndOrderFront(nil)
    }

    func close() {
        window.orderOut(nil)
    }
}
