import SwiftUI

/// Multi-step shortcut execution — Halo plans 3 steps and runs them.
/// Step states: done (green ✓), running (amber spinner), queued (dashed circle with index).
struct DockShortcutView: View {
    private struct Step: Identifiable {
        let id = UUID()
        let app: String
        let title: String
        let detail: String
        let state: State
        let time: String?
        enum State { case done, running, queued }
    }

    private let steps: [Step] = [
        .init(app: "Notes",
              title: "Create note",
              detail: "“Milo could route shortcuts through a planner step before execution.”",
              state: .done, time: "0.4s"),
        .init(app: "Reminders",
              title: "Set timer · 20 min",
              detail: "Tag: follow-up · alarm at 4:02 PM",
              state: .running, time: nil),
        .init(app: "Calendar",
              title: "Block focus time",
              detail: "Tomorrow, 9:00–10:30 AM · “Deep work”",
              state: .queued, time: nil),
    ]

    var body: some View {
        DockShell {
            DockStatusStrip(mode: .shortcut(step: 2, of: 3))

            VStack(alignment: .leading, spacing: 14) {
                // user msg
                HStack { Spacer()
                    Text("Capture this idea and remind me in 20 min, then block focus time tomorrow morning.")
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

                HStack(alignment: .top, spacing: 12) {
                    HaloOrb(size: 22, state: .thinking).padding(.top, 3)
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Got it — running 3 steps:")
                            .font(.haloUI(13.5))
                            .foregroundStyle(Color.haloFgDim)

                        VStack(spacing: 0) {
                            ForEach(Array(steps.enumerated()), id: \.element.id) { i, s in
                                stepRow(index: i + 1, step: s, last: i == steps.count - 1)
                            }
                        }
                        .background(Color.white.opacity(0.02))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .stroke(Color.white.opacity(0.08), lineWidth: 0.5)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
            }
            .padding(.horizontal, 22).padding(.top, 18).padding(.bottom, 14)

            DockInputRow(placeholder: "Add another step or speak…", disabled: true)
        }
    }

    @ViewBuilder
    private func stepRow(index: Int, step: Step, last: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            // Status puck
            statusPuck(index: index, state: step.state)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(step.app.uppercased())
                        .font(.haloMono(10))
                        .tracking(0.8)
                        .foregroundStyle(Color.haloFgFaint)
                    if let t = step.time {
                        Text(t)
                            .font(.haloMono(10))
                            .foregroundStyle(Color.haloFgFaint)
                    }
                }
                Text(step.title)
                    .font(.haloUI(14, weight: .medium))
                Text(step.detail)
                    .font(.haloUI(12.5))
                    .foregroundStyle(Color.haloFgDim)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .opacity(step.state == .queued ? 0.55 : 1.0)
        .overlay(alignment: .bottom) {
            if !last {
                Rectangle().fill(Color.white.opacity(0.06)).frame(height: 0.5)
            }
        }
    }

    @ViewBuilder
    private func statusPuck(index: Int, state: Step.State) -> some View {
        ZStack {
            switch state {
            case .done:
                Circle()
                    .fill(Color.haloGreen)
                    .frame(width: 22, height: 22)
                Text("✓")
                    .font(.haloUI(11, weight: .bold))
                    .foregroundStyle(Color(red: 0.05, green: 0.18, blue: 0.10))
            case .running:
                Circle()
                    .fill(Color.haloRunning)
                    .frame(width: 22, height: 22)
                    .shadow(color: Color.haloRunning.opacity(0.18), radius: 0, x: 0, y: 0)
                    .overlay(
                        Circle()
                            .stroke(Color.haloRunning.opacity(0.18), lineWidth: 4)
                    )
                RunningSpinner()
            case .queued:
                Circle()
                    .strokeBorder(Color.white.opacity(0.25), style: StrokeStyle(lineWidth: 0.5, dash: [3, 3]))
                    .frame(width: 22, height: 22)
                Text("\(index)")
                    .font(.haloUI(11, weight: .bold))
                    .foregroundStyle(Color.haloFgFaint)
            }
        }
        .frame(width: 22, height: 22)
    }
}

/// Tiny rotating arc inside the running puck.
private struct RunningSpinner: View {
    @State private var rotate = false
    var body: some View {
        Circle()
            .trim(from: 0, to: 0.75)
            .stroke(Color(red: 0.10, green: 0.10, blue: 0.05), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            .frame(width: 14, height: 14)
            .rotationEffect(.degrees(rotate ? 360 : 0))
            .animation(.linear(duration: 0.9).repeatForever(autoreverses: false), value: rotate)
            .onAppear { rotate = true }
    }
}
