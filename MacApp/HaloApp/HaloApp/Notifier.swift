import AppKit
import UserNotifications
import os

private let log = Logger(subsystem: "halo.runtime", category: "notifier")

/// Posts banner notifications when a chat reply lands while the dock is
/// hidden, and re-summons the dock when the user clicks one.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    private static let categoryId = "halo.reply"

    /// Tracks whether the user has been asked for permission yet — set
    /// after `requestPermission()` resolves the system prompt.
    private(set) var authorizationGranted = false

    private override init() { super.init() }

    /// Wire up the delegate + ask the OS for banner permission.
    /// Idempotent — fine to call repeatedly.
    func bootstrap() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self

        let category = UNNotificationCategory(
            identifier: Notifier.categoryId,
            actions: [],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )
        center.setNotificationCategories([category])

        // Inspect existing settings — if the user previously decided, we
        // log the current state so it's clear why posts may not appear.
        center.getNotificationSettings { settings in
            log.debug("notif settings: auth=\(String(describing: settings.authorizationStatus), privacy: .public) alert=\(String(describing: settings.alertSetting), privacy: .public)")
        }

        center.requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] granted, error in
            self?.authorizationGranted = granted
            if let error {
                log.error("auth failed: \(error.localizedDescription, privacy: .public)")
            } else {
                log.debug("auth requested → granted=\(granted)")
            }
        }
    }

    /// Post a "reply ready" notification. Truncates long bodies so the
    /// banner isn't a wall of text.
    func postReply(_ text: String) {
        log.debug("postReply: \(text.count) chars")
        let content = UNMutableNotificationContent()
        content.title = "Milo replied"
        content.body  = String(text.prefix(240))
        content.sound = .default
        content.categoryIdentifier = Notifier.categoryId

        let request = UNNotificationRequest(
            identifier: "halo.reply.\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                log.error("post failed: \(error.localizedDescription, privacy: .public)")
            } else {
                log.debug("postReply: queued")
            }
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Show banners even when the app is foregrounded. macOS won't show
    /// our notifications by default for a foreground app otherwise.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        return [.banner, .sound]
    }

    /// User clicked the notification — re-summon the dock so they can read
    /// and reply. We only handle the default tap; dismiss is a no-op.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        log.debug("didReceive: action=\(response.actionIdentifier, privacy: .public)")
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
        await MainActor.run {
            NSApp.activate(ignoringOtherApps: true)
            AppDelegate.shared?.showDock()
        }
    }
}
