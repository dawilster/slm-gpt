import SwiftUI
import AppKit
import Carbon.HIToolbox

/// Compact hotkey recorder. Tap → enters listening state, captures the next
/// modifier+key combo, writes it back to AppState (which re-registers).
struct HotkeyRecorderView: View {
    @Environment(AppState.self) private var state

    /// Optional embellishment — surfaces a "Hotkey" prefix label and trailing
    /// "Reset" button when true. The compact form (used in onboarding) hides
    /// these and just shows the keycaps + Change button.
    var fullChrome: Bool = true

    @State private var recording = false
    @State private var monitor: Any?
    @State private var hovered = false

    var body: some View {
        HStack(spacing: 10) {
            if fullChrome {
                Text("Hotkey")
                    .font(.haloUI(11.5))
                    .foregroundStyle(Color.haloFgFaint)
                Spacer(minLength: 0)
            }

            Group {
                if recording {
                    Text("Press a key combination…")
                        .font(.haloUI(12))
                        .foregroundStyle(Color.haloAccent)
                        .frame(maxWidth: .infinity)
                } else {
                    HStack(spacing: 6) {
                        let caps = state.hotkey.capStrings
                        ForEach(Array(caps.enumerated()), id: \.offset) { i, cap in
                            KeyCap(text: cap)
                            if i < caps.count - 1 {
                                Text("+").font(.haloUI(11)).foregroundStyle(Color.haloFgFaint)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 4)

            if !fullChrome { Spacer(minLength: 0) }

            Button(action: toggleRecording) {
                Text(recording ? "Cancel" : "Change")
            }
            .buttonStyle(HaloButtonStyle(fontSize: 11, paddingH: 10, paddingV: 4))

            if fullChrome {
                Button(action: resetHotkey) {
                    Text("Reset")
                }
                .buttonStyle(HaloButtonStyle(fontSize: 11, paddingH: 10, paddingV: 4))
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(Color.white.opacity(recording ? 0.06 : (hovered ? 0.05 : 0.04)))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(
                    recording ? Color.haloAccent.opacity(0.6) : Color.white.opacity(0.10),
                    lineWidth: recording ? 1 : 0.5
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .animation(.easeOut(duration: 0.10), value: recording)
        .onHover { hovered = $0 }
        .onDisappear { stopRecording() }
    }

    private func toggleRecording() {
        if recording { stopRecording() } else { startRecording() }
    }

    private func startRecording() {
        recording = true
        state.isRecordingHotkey = true
        // Local monitor so we capture keys while focus is in our process.
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .flagsChanged]) { event in
            // Ignore pure modifier-only flag changes.
            guard event.type == .keyDown else { return event }

            // Escape cancels recording (and is swallowed so the surrounding
            // window's onKeyPress(.escape) doesn't dismiss it).
            if Int(event.keyCode) == kVK_Escape {
                stopRecording()
                return nil
            }

            let cocoaMods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            let modifiers = Hotkey.carbonFlags(from: cocoaMods)

            // Require at least one modifier to avoid bare-key bindings.
            guard modifiers != 0 else { return event }

            let captured = Hotkey(modifiers: modifiers, keyCode: UInt32(event.keyCode))
            state.hotkey = captured
            stopRecording()
            return nil          // swallow the keystroke
        }
    }

    private func stopRecording() {
        recording = false
        state.isRecordingHotkey = false
        if let m = monitor { NSEvent.removeMonitor(m); monitor = nil }
    }

    private func resetHotkey() {
        stopRecording()
        state.hotkey = .default
    }
}
