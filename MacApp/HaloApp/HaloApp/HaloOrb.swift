import SwiftUI

/// The brand orb — gradient sphere with offset highlight.
/// Used in dock chrome, menubar panel, onboarding, first-run.
struct HaloOrb: View {
    var size: CGFloat = 48
    var state: HaloMenubarState = .idle

    @State private var breathe = false
    @State private var rotate = false
    @State private var pulse = false

    var body: some View {
        ZStack {
            // Outer halo ring (listening / thinking)
            if state == .listening || state == .thinking {
                Circle()
                    .stroke(Color.haloAccent, lineWidth: 1.5)
                    .padding(-6)
                    .scaleEffect(pulse ? 1.18 : 1.0)
                    .opacity(pulse ? 0 : 0.45)
                    .animation(.easeOut(duration: 1.6).repeatForever(autoreverses: false), value: pulse)
            }

            // Sphere body — radial gradient with off-center highlight
            Circle()
                .fill(
                    RadialGradient(
                        gradient: Gradient(stops: [
                            .init(color: Color(red: 0.90, green: 0.90, blue: 0.99), location: 0.00),
                            .init(color: Color(red: 0.55, green: 0.55, blue: 0.95), location: 0.35),
                            .init(color: Color(red: 0.27, green: 0.22, blue: 0.55), location: 0.75),
                            .init(color: Color(red: 0.13, green: 0.10, blue: 0.22), location: 1.00),
                        ]),
                        center: UnitPoint(x: 0.30, y: 0.28),
                        startRadius: 0,
                        endRadius: size * 0.55
                    )
                )
                .overlay(
                    Circle().stroke(Color.white.opacity(0.30), lineWidth: 0.5)
                )
                .overlay(
                    // Soft glossy highlight inside
                    Circle()
                        .fill(RadialGradient(
                            gradient: Gradient(stops: [
                                .init(color: Color.white.opacity(0.45), location: 0.0),
                                .init(color: Color.white.opacity(0.0), location: 0.55),
                            ]),
                            center: UnitPoint(x: 0.35, y: 0.30),
                            startRadius: 0,
                            endRadius: size * 0.32
                        ))
                        .padding(size * 0.12)
                )
                .shadow(color: Color.haloAccent.opacity(0.55), radius: size * 0.5, x: 0, y: size * 0.18)
                .rotationEffect(state == .thinking ? (rotate ? .degrees(360) : .degrees(0)) : .degrees(0))
                .animation(
                    state == .thinking ? .linear(duration: 2.4).repeatForever(autoreverses: false) : .default,
                    value: rotate
                )
                .scaleEffect(state == .idle && breathe ? 1.06 : 1.0)
                .animation(
                    state == .idle ? .easeInOut(duration: 4.5).repeatForever(autoreverses: true) : .default,
                    value: breathe
                )
        }
        .frame(width: size, height: size)
        .onAppear {
            breathe = true
            rotate = true
            pulse = true
        }
    }
}
