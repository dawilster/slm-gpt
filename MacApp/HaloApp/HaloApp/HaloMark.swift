import SwiftUI

/// The Halo glyph: partial ring around a small filled dot. Rendered into a
/// static `NSImage` for the menubar via `ImageRenderer`, so all motion is
/// driven externally by `phaseDegrees` — `StatusBarController` re-rasterizes
/// at ~10Hz while the runtime is thinking or loading.
///
/// States:
///   offline   — partial 3/4 arc + center dot, dimmed (~40% alpha)
///   idle      — partial 3/4 arc, slightly dim
///   listening — full ring + faint outer halo
///   thinking  — long dashed arc, rotation = phaseDegrees
///   loading   — short dashed arc, rotation = phaseDegrees
struct HaloMark: View {
    var size: CGFloat = 16
    var state: HaloMenubarState = .idle
    var color: Color = .white
    var phaseDegrees: Double = 0

    private var stroke: CGFloat { 1.6 }
    private var dotR: CGFloat { state == .listening ? size * 0.22 : size * 0.16 }

    private var dashPattern: [CGFloat] {
        switch state {
        case .listening: return []                       // solid full ring
        case .thinking:  return [size * 0.6, size * 0.4]
        case .loading:   return [size * 0.3, size * 0.7]
        case .idle, .offline:
                         return [size * 1.6, size * 0.6] // ~3/4 arc
        }
    }

    private var ringOpacity: Double {
        switch state {
        case .offline: return 0.38
        case .idle:    return 0.85
        default:       return 1.0
        }
    }

    private var dotOpacity: Double {
        state == .offline ? 0.38 : 1.0
    }

    var body: some View {
        ZStack {
            // Faint outer halo for listening — static, no pulse animation
            // since this view rasterizes to a single frame.
            if state == .listening {
                Circle()
                    .stroke(color.opacity(0.35), lineWidth: 1)
                    .padding(-2)
            }

            Circle()
                .strokeBorder(
                    color.opacity(ringOpacity),
                    style: StrokeStyle(
                        lineWidth: stroke,
                        lineCap: .round,
                        dash: dashPattern
                    )
                )
                .padding(stroke / 2)
                .rotationEffect(.degrees(phaseDegrees))

            Circle()
                .fill(color.opacity(dotOpacity))
                .frame(width: dotR * 2, height: dotR * 2)
        }
        .frame(width: size, height: size)
    }
}
