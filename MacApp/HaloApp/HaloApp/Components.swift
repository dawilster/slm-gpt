import SwiftUI
import AppKit

// MARK: - Vibrancy / glass

struct VisualEffectBackground: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .hudWindow
    var blendingMode: NSVisualEffectView.BlendingMode = .behindWindow
    var emphasized: Bool = true

    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = material
        v.blendingMode = blendingMode
        v.state = .active
        v.isEmphasized = emphasized
        return v
    }
    func updateNSView(_ v: NSVisualEffectView, context: Context) {
        v.material = material
        v.blendingMode = blendingMode
    }
}

// MARK: - Hairline divider (matches .halo-hr — 0.5px white-08)

struct Hairline: View {
    var color: Color = .haloHairline
    var body: some View {
        Rectangle().fill(color).frame(height: 0.5)
    }
}

// MARK: - Numeric stat block (model card readouts)

struct StatView: View {
    let label: String
    let value: String
    let unit: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text(value)
                    .font(.haloMono(14))
                    .foregroundStyle(Color.haloFg)
                    .monospacedDigit()
                if !unit.isEmpty {
                    Text(unit)
                        .font(.haloMono(9.5))
                        .foregroundStyle(Color.haloFgFaint)
                }
            }
            Text(label.uppercased())
                .font(.haloUI(9.5))
                .tracking(0.6)
                .foregroundStyle(Color.haloFgFaint)
        }
    }
}

// MARK: - Keycap (used in onboarding hotkey picker, dock input row)

struct KeyCap: View {
    let text: String
    var minWidth: CGFloat = 26
    var height: CGFloat = 24
    var fontSize: CGFloat = 12

    var body: some View {
        Text(text)
            .font(.haloMono(fontSize, weight: .regular))
            .foregroundStyle(Color.haloFg)
            .frame(minWidth: minWidth)
            .frame(height: height)
            .padding(.horizontal, 8)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.white.opacity(0.08))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(Color.white.opacity(0.14), lineWidth: 0.5)
                    )
                    .shadow(color: .black.opacity(0.25), radius: 0, x: 0, y: -1)
            )
    }
}

// MARK: - Inline tray-style key (used in input row hints)

struct InlineKey: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.haloMono(10.5))
            .foregroundStyle(Color.haloFgFaint)
            .frame(minWidth: 18, minHeight: 18)
            .padding(.horizontal, 5)
            .background(
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(Color.white.opacity(0.06))
                    .overlay(
                        RoundedRectangle(cornerRadius: 4, style: .continuous)
                            .stroke(Color.white.opacity(0.10), lineWidth: 0.5)
                    )
            )
    }
}

// MARK: - Halo button (secondary + primary, with hover)

struct HaloButtonStyle: ButtonStyle {
    enum Variant { case secondary, primary }
    var variant: Variant = .secondary
    var fontSize: CGFloat = 13
    var paddingH: CGFloat = 14
    var paddingV: CGFloat = 8

    func makeBody(configuration: Configuration) -> some View {
        HaloButtonContent(
            configuration: configuration,
            variant: variant,
            fontSize: fontSize,
            paddingH: paddingH,
            paddingV: paddingV
        )
    }
}

private struct HaloButtonContent: View {
    let configuration: ButtonStyle.Configuration
    let variant: HaloButtonStyle.Variant
    let fontSize: CGFloat
    let paddingH: CGFloat
    let paddingV: CGFloat

    @State private var hovered = false

    var body: some View {
        configuration.label
            .font(.haloUI(fontSize, weight: variant == .primary ? .medium : .regular))
            .foregroundStyle(variant == .primary ? Color.white : Color.haloFg)
            .padding(.horizontal, paddingH)
            .padding(.vertical, paddingV)
            .background(background)
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(variant == .primary ? Color.white.opacity(0.22)
                                                : Color.white.opacity(hovered ? 0.18 : 0.12),
                            lineWidth: 0.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .shadow(
                color: variant == .primary ? Color.haloAccent.opacity(hovered ? 0.55 : 0.45) : .clear,
                radius: variant == .primary ? (hovered ? 18 : 14) : 0, x: 0, y: 4
            )
            .opacity(configuration.isPressed ? 0.85 : 1)
            .brightness(variant == .primary && hovered ? 0.05 : 0)
            .scaleEffect(configuration.isPressed ? 0.98 : 1.0)
            .animation(.easeOut(duration: 0.10), value: hovered)
            .animation(.easeOut(duration: 0.08), value: configuration.isPressed)
            .onHover { hovered = $0 }
    }

    @ViewBuilder
    private var background: some View {
        if variant == .primary {
            LinearGradient(
                colors: [Color.haloAccent, Color.haloAccentDim],
                startPoint: .top, endPoint: .bottom
            )
        } else {
            Color.white.opacity(configuration.isPressed ? 0.10 : (hovered ? 0.09 : 0.05))
        }
    }
}

// MARK: - Hover overlay for clickable rows / pills

struct HaloHover: ViewModifier {
    var corner: CGFloat = 6
    var color: Color = Color.white.opacity(0.06)

    @State private var hovered = false

    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: corner, style: .continuous)
                    .fill(hovered ? color : .clear)
                    .animation(.easeOut(duration: 0.10), value: hovered)
            )
            .contentShape(Rectangle())
            .onHover { hovered = $0 }
    }
}

extension View {
    func haloHover(corner: CGFloat = 6, color: Color = Color.white.opacity(0.06)) -> some View {
        modifier(HaloHover(corner: corner, color: color))
    }
}

// MARK: - Progress bar (gradient fill)

struct ProgressBarView: View {
    /// 0.0 ... 1.0
    var value: Double
    var height: CGFloat = 4

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.08))
                Capsule()
                    .fill(LinearGradient(
                        colors: [Color.haloAccent, Color(red: 0.55, green: 0.85, blue: 0.95)],
                        startPoint: .leading, endPoint: .trailing
                    ))
                    .frame(width: max(0, min(geo.size.width, geo.size.width * value)))
            }
        }
        .frame(height: height)
    }
}

// MARK: - Privacy pill

struct PrivacyPill: View {
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(Color.haloGreen).frame(width: 6, height: 6)
            Text("On-device").font(.haloUI(10.5))
        }
        .foregroundStyle(Color.haloFgDim)
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
        .overlay(
            Capsule().stroke(Color.white.opacity(0.12), lineWidth: 0.5)
        )
    }
}

// MARK: - Status dot (used in dock status strip)

struct StatusDot: View {
    var color: Color
    var glow: Bool = true
    var size: CGFloat = 7

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .shadow(color: glow ? color : .clear, radius: 4)
    }
}

// MARK: - Vertical separator (used in dock status strip)

struct VRule: View {
    var height: CGFloat = 10
    var body: some View {
        Rectangle().fill(Color.white.opacity(0.12)).frame(width: 1, height: height)
    }
}

// MARK: - Borderless-window close button

/// Traffic-light–style close button. The × glyph appears on hover so the
/// idle state stays visually quiet, matching macOS native chrome.
struct WindowCloseButton: View {
    let action: () -> Void

    @State private var hovered = false
    @State private var pressed = false

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(Color(red: 1.00, green: 0.37, blue: 0.36))
                    .overlay(Circle().stroke(Color.black.opacity(0.18), lineWidth: 0.5))
                if hovered {
                    Image(systemName: "xmark")
                        .font(.system(size: 7.5, weight: .bold))
                        .foregroundStyle(Color.black.opacity(0.65))
                }
            }
            .frame(width: 12, height: 12)
            .scaleEffect(pressed ? 0.92 : 1.0)
            .animation(.easeOut(duration: 0.08), value: pressed)
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .simultaneousGesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in pressed = true }
                .onEnded   { _ in pressed = false }
        )
    }
}
