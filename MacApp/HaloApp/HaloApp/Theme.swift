import SwiftUI

// Color tokens — sRGB approximations of the design's oklch palette.
extension Color {
    static let haloBgDeep      = Color(red: 0.13, green: 0.14, blue: 0.16)
    static let haloBgMid       = Color(red: 0.19, green: 0.20, blue: 0.23)
    static let haloFg          = Color(red: 0.965, green: 0.965, blue: 0.97)
    static let haloFgDim       = Color(red: 0.69, green: 0.69, blue: 0.71)
    static let haloFgFaint     = Color(red: 0.50, green: 0.50, blue: 0.53)
    static let haloAccent      = Color(red: 0.55, green: 0.58, blue: 0.95)
    static let haloAccentDim   = Color(red: 0.41, green: 0.43, blue: 0.74)
    static let haloAccentSoft  = Color(red: 0.62, green: 0.66, blue: 0.99)
    static let haloWarn        = Color(red: 0.93, green: 0.74, blue: 0.34)
    static let haloRunning     = Color(red: 0.94, green: 0.78, blue: 0.32)
    static let haloGreen       = Color(red: 0.42, green: 0.80, blue: 0.50)

    static let haloGlassStroke       = Color.white.opacity(0.10)
    static let haloGlassStrokeStrong = Color.white.opacity(0.18)
    static let haloGlassFill         = Color.white.opacity(0.06)
    static let haloHairline          = Color.white.opacity(0.08)
}

// Typography — SF Pro for UI, SF Mono for technical readouts.
extension Font {
    static func haloMono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
    static func haloUI(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .default)
    }
}

// Shared shape constants.
enum HaloMetrics {
    static let dockWidth: CGFloat = 720
    static let panelWidth: CGFloat = 320
    static let dockCornerRadius: CGFloat = 22
    static let panelCornerRadius: CGFloat = 14
}
