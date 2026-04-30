import SwiftUI

/// Just-summoned, empty input. Privacy + readiness lead.
struct DockIdleView: View {
    @Environment(AppState.self) private var state

    var body: some View {
        DockShell {
            DockStatusStrip(mode: .ready)

            VStack {
                Text("Ask anything — your conversations stay on this device.")
                    .font(.haloUI(13))
                    .foregroundStyle(Color.haloFgDim)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, minHeight: 80)
            .padding(.horizontal, 22)
            .padding(.top, 28).padding(.bottom, 22)

            DockInputRow(
                placeholder: "Ask Milo…",
                showHints: true,
                onSubmit: { _ in
                    // STUB: send prompt to the model. Flip to the thinking
                    // screen so streaming UI is visible.
                    withAnimation(.easeOut(duration: 0.18)) {
                        state.dockScreen = .thinking
                        state.menubarState = .thinking
                    }
                }
            )
        }
    }
}
