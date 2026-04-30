import SwiftUI

/// First-run model download. Verified-SHA badge, fake animated progress.
/// STUB: progress is a timer; wire to real download when runtime lands.
struct FirstRunView: View {
    var onDone: () -> Void = {}
    var onClose: () -> Void = {}

    @State private var progress: Double = 0.616 // matches design ~61.6%
    @State private var timer: Timer? = nil
    @State private var paused: Bool = false

    var body: some View {
        DockShell {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 14) {
                    HaloOrb(size: 36, state: .loading)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Downloading your model")
                            .font(.haloUI(15, weight: .semibold))
                            .tracking(-0.15)
                        Text("This happens once. Milo runs entirely on your Mac after this.")
                            .font(.haloUI(12))
                            .foregroundStyle(Color.haloFgDim)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.bottom, 18)

                modelCard
                    .padding(.bottom, 14)

                HStack {
                    HStack(spacing: 6) {
                        Circle().fill(Color.haloGreen).frame(width: 5, height: 5)
                        Text("Verified · SHA-256")
                    }
                    .font(.haloUI(11.5))
                    .foregroundStyle(Color.haloFgFaint)

                    Spacer(minLength: 0)

                    HStack(spacing: 8) {
                        Button(action: togglePause) {
                            Text(paused ? "Resume" : "Pause")
                        }
                        .buttonStyle(HaloButtonStyle(fontSize: 11.5, paddingH: 10, paddingV: 5))

                        Button(action: { /* STUB: open model picker */ }) {
                            Text("Choose another")
                        }
                        .buttonStyle(HaloButtonStyle(fontSize: 11.5, paddingH: 10, paddingV: 5))
                    }
                }
            }
            .padding(.horizontal, 28).padding(.top, 26).padding(.bottom, 22)
        }
        .overlay(alignment: .topLeading) {
            WindowCloseButton(action: onClose)
                .padding(14)
        }
        .onKeyPress(.escape) {
            onClose()
            return .handled
        }
        .onAppear { startTimer() }
        .onDisappear { timer?.invalidate() }
    }

    private func togglePause() {
        paused.toggle()
        if paused { timer?.invalidate(); timer = nil }
        else      { startTimer() }
    }

    private func startTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { t in
            progress = min(1.0, progress + 0.005)
            if progress >= 1.0 {
                t.invalidate()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { onDone() }
            }
        }
    }

    private var modelCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("llama-3.3-8b-instruct · q4_K_M")
                    .font(.haloMono(12))
                Spacer(minLength: 0)
                Text(String(format: "%.2f / 4.61 GB", progress * 4.61))
                    .font(.haloMono(11))
                    .foregroundStyle(Color.haloFgDim)
                    .monospacedDigit()
            }

            ProgressBarView(value: progress)

            HStack {
                Text(String(format: "%.1f%%", progress * 100))
                Spacer(minLength: 0)
                Text("28.4 MB/s")
                Spacer(minLength: 0)
                Text(remainingString)
            }
            .font(.haloMono(10.5))
            .foregroundStyle(Color.haloFgFaint)
            .monospacedDigit()
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(Color.white.opacity(0.03))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 0.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var remainingString: String {
        let remainingSeconds = max(0, Int((1.0 - progress) * 165))
        let m = remainingSeconds / 60
        let s = remainingSeconds % 60
        return m > 0 ? "~\(m)m \(String(format: "%02d", s))s remaining" : "~\(s)s remaining"
    }
}
