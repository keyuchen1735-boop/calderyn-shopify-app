// Shared build-progress card: one or more {dot, title, sub} rows inside the
// cd-work-card/cd-buildlist shell. Used by the chat rail's inline working
// card (ChatRail.tsx, a single row driven by the live build phase) and the
// welcome overlay's import/build progress list (WelcomeOverlay.tsx, several
// rows driven by real import counts).
export interface BuildStepRow {
  dot: "run" | "done" | "wait";
  /** Overrides the dot's default color for this row (e.g. a failure red/orange). */
  dotColor?: string;
  title: string;
  sub: string;
}

export default function BuildStepsCard({
  rows,
  className,
  dimPending,
}: {
  rows: BuildStepRow[];
  /** Extra class on the card shell (the welcome overlay adds its own positioning class). */
  className?: string;
  /** Dim not-yet-reached ("wait") rows to 50% opacity — wanted for a multi-step
   *  progress list; NOT set for a single-row card whose "wait" state is always
   *  a colored failure notice rather than a step that hasn't started yet. */
  dimPending?: boolean;
}) {
  return (
    <div className={className ? `cd-work-card ${className}` : "cd-work-card"}>
      <div className="cd-buildlist">
        {rows.map((r) => (
          <div key={r.title} className="cd-build-step" data-st={dimPending ? r.dot : undefined}>
            <span className="cd-build-dot" data-st={r.dot} style={r.dotColor ? { background: r.dotColor } : undefined} />
            <div>
              <div className="cd-build-title">{r.title}</div>
              <div className="cd-build-sub">{r.sub}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
