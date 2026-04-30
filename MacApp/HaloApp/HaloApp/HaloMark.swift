import SwiftUI

/// The Halo glyph: partial ring around a small filled dot.
/// States and motion match the design's halo-mark spec exactly:
///   idle      — slow breathe, partial 3/4 arc
///   listening — full ring + outer halo pulse, larger center dot
///   thinking  — dashed arc rotating
///   loading   — short dashed arc rotating (like a spinner)
struct HaloMark: View {
    var size: CGFloat = 16
    var state: HaloMenubarState = .idle
    var color: Color = .white

    @State private var rotate: Bool = false
    @State private var breathe: Bool = false
    @State private var pulse: Bool = false

    private var stroke: CGFloat { 1.6 }
    private var radius: CGFloat { size / 2 - stroke }
    private var dotR: CGFloat { state == .listening ? size * 0.22 : size * 0.16 }

    private var dashPattern: [CGFloat] {
        switch state {
        case .listening: return []                       // solid full ring
        case .thinking:  return [size * 0.6, size * 0.4]
        case .loading:   return [size * 0.3, size * 0.7]
        case .idle:      return [size * 1.6, size * 0.6] // ~3/4 arc
        }
    }

    var body: some View {
        ZStack {
            // Outer halo pulse — listening only
            if state == .listening {
                Circle()
                    .stroke(color.opacity(0.4), lineWidth: 1)
                    .scaleEffect(pulse ? 1.18 : 1.0)
                    .opacity(pulse ? 0 : 0.45)
                    .animation(.easeOut(duration: 1.6).repeatForever(autoreverses: false),
                               value: pulse)
            }

            // Ring
            Circle()
                .strokeBorder(
                    color.opacity(state == .idle ? 0.85 : 1.0),
                    style: StrokeStyle(
                        lineWidth: stroke,
                        lineCap: .round,
                        dash: dashPattern
                    )
                )
                .padding(stroke / 2)
                .rotationEffect(rotate ? .degrees(360) : .degrees(0))
                .animation(
                    state == .thinking || state == .loading
                    ? .linear(duration: state == .loading ? 1.2 : 2.4).repeatForever(autoreverses: false)
                    : .default,
                    value: rotate
                )

            // Center dot
            Circle()
                .fill(color)
                .frame(width: dotR * 2, height: dotR * 2)
        }
        .frame(width: size, height: size)
        .scaleEffect(state == .idle && breathe ? 1.06 : 1.0)
        .animation(
            state == .idle ? .easeInOut(duration: 4.5).repeatForever(autoreverses: true) : .default,
            value: breathe
        )
        .onAppear {
            breathe = true
            rotate = true
            pulse = true
        }
        .onChange(of: state) { _, _ in
            breathe = true; rotate = true; pulse = true
        }
    }
}
