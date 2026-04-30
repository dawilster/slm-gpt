import AppKit
import Carbon.HIToolbox

// MARK: - Hotkey value type

/// A user-bindable global hotkey. Modifier flags use the Carbon constants
/// (cmdKey/optionKey/shiftKey/controlKey) — that's what RegisterEventHotKey
/// expects, and it survives a UserDefaults round-trip cleanly.
struct Hotkey: Equatable, Codable {
    var modifiers: UInt32
    var keyCode:   UInt32

    static let `default` = Hotkey(modifiers: UInt32(optionKey), keyCode: UInt32(kVK_Space))

    /// "⌥ Space" / "⌃ ⌘ K" — for tooltips and KeyCap rendering.
    var displayString: String {
        var parts: [String] = []
        if modifiers & UInt32(controlKey) != 0 { parts.append("⌃") }
        if modifiers & UInt32(optionKey)  != 0 { parts.append("⌥") }
        if modifiers & UInt32(shiftKey)   != 0 { parts.append("⇧") }
        if modifiers & UInt32(cmdKey)     != 0 { parts.append("⌘") }
        parts.append(Hotkey.keyName(for: keyCode))
        return parts.joined(separator: " ")
    }

    /// Modifier glyphs as separate KeyCap entries, e.g. ["⌥", "Space"].
    var capStrings: [String] {
        var parts: [String] = []
        if modifiers & UInt32(controlKey) != 0 { parts.append("⌃") }
        if modifiers & UInt32(optionKey)  != 0 { parts.append("⌥") }
        if modifiers & UInt32(shiftKey)   != 0 { parts.append("⇧") }
        if modifiers & UInt32(cmdKey)     != 0 { parts.append("⌘") }
        parts.append(Hotkey.keyName(for: keyCode))
        return parts
    }

    static func keyName(for keyCode: UInt32) -> String {
        switch Int(keyCode) {
        case kVK_Space:        return "Space"
        case kVK_Return:       return "↵"
        case kVK_Tab:          return "⇥"
        case kVK_Escape:       return "Esc"
        case kVK_Delete:       return "⌫"
        case kVK_ForwardDelete: return "⌦"
        case kVK_LeftArrow:    return "←"
        case kVK_RightArrow:   return "→"
        case kVK_UpArrow:      return "↑"
        case kVK_DownArrow:    return "↓"
        case kVK_F1:  return "F1"
        case kVK_F2:  return "F2"
        case kVK_F3:  return "F3"
        case kVK_F4:  return "F4"
        case kVK_F5:  return "F5"
        case kVK_F6:  return "F6"
        case kVK_F7:  return "F7"
        case kVK_F8:  return "F8"
        case kVK_F9:  return "F9"
        case kVK_F10: return "F10"
        case kVK_F11: return "F11"
        case kVK_F12: return "F12"
        default:
            return Hotkey.character(for: keyCode)?.uppercased() ?? "Key \(keyCode)"
        }
    }

    /// Use the current keyboard layout to render `keyCode` as a typed
    /// character (handles Dvorak/Colemak/etc. correctly).
    private static func character(for keyCode: UInt32) -> String? {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let layoutDataPtr = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
        else { return nil }
        let layoutData = Unmanaged<CFData>.fromOpaque(layoutDataPtr).takeUnretainedValue() as Data
        return layoutData.withUnsafeBytes { bytes -> String? in
            guard let layoutPtr = bytes.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self)
            else { return nil }
            var deadKey: UInt32 = 0
            var length = 0
            var chars = [UniChar](repeating: 0, count: 4)
            let status = UCKeyTranslate(
                layoutPtr,
                UInt16(keyCode),
                UInt16(kUCKeyActionDisplay),
                0,
                UInt32(LMGetKbdType()),
                OptionBits(kUCKeyTranslateNoDeadKeysBit),
                &deadKey,
                chars.count,
                &length,
                &chars
            )
            guard status == noErr, length > 0 else { return nil }
            return String(utf16CodeUnits: chars, count: length)
        }
    }

    /// Convert NSEvent modifier flags (Cocoa) → Carbon flags. Used by the
    /// recorder when capturing a press.
    static func carbonFlags(from cocoa: NSEvent.ModifierFlags) -> UInt32 {
        var f: UInt32 = 0
        if cocoa.contains(.command) { f |= UInt32(cmdKey) }
        if cocoa.contains(.option)  { f |= UInt32(optionKey) }
        if cocoa.contains(.shift)   { f |= UInt32(shiftKey) }
        if cocoa.contains(.control) { f |= UInt32(controlKey) }
        return f
    }
}

// MARK: - Global hotkey registration (Carbon, sandbox-safe)

/// Registers a single global hotkey via the Carbon Event Manager. Works in a
/// sandboxed Mac App Store app without any extra entitlements.
final class HotkeyManager {
    private var hotkeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private var trampoline: HotkeyTrampoline?

    /// Replace the registered hotkey with a new one, routing presses to
    /// `action`. Pass nil to clear the binding.
    func register(_ hotkey: Hotkey?, action: @escaping () -> Void) {
        unregister()
        guard let hotkey else { return }

        let trampoline = HotkeyTrampoline(action: action)
        self.trampoline = trampoline

        let trampolinePtr = Unmanaged.passUnretained(trampoline).toOpaque()
        var spec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind:  UInt32(kEventHotKeyPressed)
        )
        var handler: EventHandlerRef?
        InstallEventHandler(GetApplicationEventTarget(), { _, eventRef, userData -> OSStatus in
            guard let userData, let eventRef else { return noErr }
            var hkID = EventHotKeyID()
            let status = GetEventParameter(
                eventRef,
                EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID),
                nil,
                MemoryLayout<EventHotKeyID>.size,
                nil,
                &hkID
            )
            if status == noErr {
                Unmanaged<HotkeyTrampoline>.fromOpaque(userData).takeUnretainedValue().fire()
            }
            return noErr
        }, 1, &spec, trampolinePtr, &handler)
        self.handlerRef = handler

        var ref: EventHotKeyRef?
        let signature: OSType = 0x48414C4F   // 'HALO'
        let id = EventHotKeyID(signature: signature, id: 1)
        RegisterEventHotKey(hotkey.keyCode, hotkey.modifiers, id, GetApplicationEventTarget(), 0, &ref)
        self.hotkeyRef = ref
    }

    func unregister() {
        if let h = hotkeyRef    { UnregisterEventHotKey(h); hotkeyRef = nil }
        if let h = handlerRef   { RemoveEventHandler(h);   handlerRef = nil }
        trampoline = nil
    }

    deinit { unregister() }
}

private final class HotkeyTrampoline {
    let action: () -> Void
    init(action: @escaping () -> Void) { self.action = action }
    func fire() { DispatchQueue.main.async { self.action() } }
}
