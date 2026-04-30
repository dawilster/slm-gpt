import SwiftUI

/// Mid-stream — user message bubble, streaming assistant reply with shimmer + caret.
struct DockThinkingView: View {
    @State private var shimmerPhase: CGFloat = -1.0
    @State private var caretOn: Bool = true

    var body: some View {
        DockShell {
            DockStatusStrip(mode: .thinking(stepHint: nil))

            VStack(alignment: .leading, spacing: 14) {
                // User message — right aligned
                HStack { Spacer()
                    Text("Refactor this Swift function to use async/await and explain the change.")
                        .font(.haloUI(14))
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(Color.white.opacity(0.08))
                        .overlay(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .stroke(Color.white.opacity(0.10), lineWidth: 0.5)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .frame(maxWidth: 0.85 * HaloMetrics.dockWidth, alignment: .trailing)
                }

                // Streaming assistant
                HStack(alignment: .top, spacing: 12) {
                    HaloOrb(size: 22, state: .thinking)
                        .padding(.top, 3)

                    streamingText
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, 22).padding(.top, 18).padding(.bottom, 14)

            DockInputRow(placeholder: "Reply or follow up…", disabled: true)
        }
        .onAppear {
            withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: false)) {
                shimmerPhase = 1.0
            }
            withAnimation(.easeInOut(duration: 0.5).repeatForever(autoreverses: true)) {
                caretOn.toggle()
            }
        }
    }

    private var streamingText: some View {
        Text(streamingAttributedText)
            .font(.haloUI(15))
            .foregroundColor(Color.haloFg)
            .lineSpacing(3)
            .overlay(alignment: .bottomTrailing) {
                Rectangle()
                    .fill(Color.haloAccent)
                    .frame(width: 7, height: 18)
                    .opacity(caretOn ? 1.0 : 0.2)
                    .padding(.leading, 4)
            }
    }

    private var streamingAttributedText: AttributedString {
        var s = AttributedString("Switching this to ")

        var mono = AttributedString("async/await")
        mono.font = .haloMono(13)
        s += mono

        s += AttributedString(" removes the completion-handler nesting and lets errors propagate through normal ")

        var faint = AttributedString("Swift try/throws")
        faint.foregroundColor = Color.haloFgFaint
        s += faint
        return s
    }
}
