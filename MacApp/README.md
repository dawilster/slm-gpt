# Halo — Mac App

Native SwiftUI implementation of the Halo Mac assistant. UI shell only — model loading, hotkey listening, shortcut execution, and tokens-per-second readouts are stubbed.

## Run it

```sh
open MacApp/HaloApp/HaloApp.xcodeproj
# ⌘R
```

The Xcode project uses synchronized file groups, so any `.swift` file dropped into `MacApp/HaloApp/HaloApp/` is picked up automatically — no project edits needed.

The app launches as a menubar accessory (no Dock icon, no main window). Click the Halo glyph in the menubar to open the dropdown. From there:

- **Right-click anywhere on the dropdown** for dev controls:
  - **Summon dock** — opens the floating chat dock at the bottom of the screen.
  - **Cycle dock state** — Idle → Thinking → Shortcut, so every screen is reachable.
  - **Run setup again** — clears `UserDefaults` flags and re-shows onboarding + first-run.
- **Settings** in the footer opens the settings window.

On first launch the app shows Onboarding → First-run download → settles into the menubar.

## Files

| Surface | File |
| --- | --- |
| `@main`, scenes, AppDelegate | `HaloAppApp.swift` |
| Window controllers (NSPanel + auxiliary) | `Windows.swift` |
| Observable state | `AppState.swift` |
| Color/font tokens | `Theme.swift` |
| Shared bits (vibrancy, keycap, stat, button styles) | `Components.swift` |
| Halo glyph (menubar icon, idle/listening/thinking/loading) | `HaloMark.swift` |
| Brand orb | `HaloOrb.swift` |
| Menubar dropdown | `MenubarPanel.swift` |
| Dock chrome (status strip, input row) | `DockShell.swift` |
| Dock screens | `DockIdleView.swift`, `DockThinkingView.swift`, `DockShortcutView.swift` |
| Setup screens | `OnboardingView.swift`, `FirstRunView.swift` |
| Settings window | `SettingsView.swift` |

## Stubs to wire up later

Search `// STUB:`. Currently:

- Hotkey is **not** registered globally (the dropdown's "Summon" command is the entry point).
- Model download progress is animated but not real.
- No actual chat / inference.
- No real Shortcuts/Notes/Calendar execution.
- Tokens-per-second / RAM readouts are static.

## Notes for runtime work

- **App sandbox** is enabled in the project settings. Global hotkey registration via Carbon `RegisterEventHotKey` works inside the sandbox; `NSEvent.addGlobalMonitor` for keyboard events does not. Plan accordingly.
- The menubar agent behavior is set programmatically (`NSApp.setActivationPolicy(.accessory)`). If you want the app to start as agent-only before any code runs, add `LSUIElement = YES` to the Info.plist (or set `INFOPLIST_KEY_LSUIElement = YES` in build settings).
- The Halo glyph in the menubar is a static snapshot per state — animations don't drive `MenuBarExtra`'s label. If you want a live breathing/spinning icon, switch to a custom `NSStatusItem` whose button hosts an `NSHostingView` of `HaloMark`.
