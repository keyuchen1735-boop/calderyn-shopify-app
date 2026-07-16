import { useCallback, useEffect, useRef, useState } from "react";
import { CDIcon } from "../icons";
import type { DashboardCtx } from "../context";

type Tone = "critical" | "accent";
interface ReplayEvent {
  t: string;
  tone: Tone;
  icon: string;
  title: string;
  sub: string;
}

// The scripted autopilot timeline, revealed one row per step (slice(0, step)).
const EVENTS: ReplayEvent[] = [
  {
    t: "09:42:11",
    tone: "critical",
    icon: "box",
    title: "Inventory hit zero",
    sub: "Summit Logo Tee — M sold out · Shopify webhook",
  },
  {
    t: "09:42:18",
    tone: "critical",
    icon: "scan",
    title: "Detector fired — fulfillment risk",
    sub: "Live campaign still driving a sold-out SKU",
  },
  {
    t: "09:42:41",
    tone: "accent",
    icon: "shield",
    title: "Guardrails cleared",
    sub: "Within daily budget · reversible · inside business hours",
  },
  {
    t: "09:42:49",
    tone: "accent",
    icon: "pause",
    title: "Paused “Summit Tee — Prospecting”",
    sub: "Meta · $480/day → $0 · logged to action history",
  },
];

const SAVED_TARGET = 1840;

export default function Labs({ app }: { app: DashboardCtx }) {
  const [step, setStep] = useState(0);
  const [saved, setSaved] = useState(0);
  const [flipped, setFlipped] = useState(false);
  // Bumped by Replay to re-run the timeline effect from the top.
  const [runId, setRunId] = useState(0);

  const timers = useRef<number[]>([]);
  const raf = useRef<number | null>(null);

  const clear = useCallback(() => {
    timers.current.forEach((id) => clearTimeout(id));
    timers.current = [];
    if (raf.current != null) cancelAnimationFrame(raf.current);
    raf.current = null;
  }, []);

  // Eased count-up for "wasted spend prevented" ($0 → $1,840 over 1.1s).
  const countUp = useCallback(() => {
    const dur = 1100;
    const start = performance.now();
    const tick = (now: number) => {
      const x = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - x, 3);
      setSaved(Math.round(SAVED_TARGET * eased));
      if (x < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, []);

  // Run (and re-run on replay) the scripted sequence; clean up on unmount/replay.
  useEffect(() => {
    clear();
    setStep(0);
    setSaved(0);
    setFlipped(false);
    const at = (fn: () => void, ms: number) =>
      timers.current.push(window.setTimeout(fn, ms));
    at(() => setStep(1), 550);
    at(() => setStep(2), 1500);
    at(() => {
      setStep(3);
      countUp();
    }, 2550);
    at(() => setStep(4), 3600);
    at(() => {
      setSaved(SAVED_TARGET);
      setFlipped(true);
    }, 4250);
    return clear;
  }, [runId, clear, countUp]);

  const replay = useCallback(() => {
    document.getElementById("cd-main")?.scrollTo({ top: 0 });
    setRunId((n) => n + 1);
  }, []);

  const undoResume = useCallback(() => {
    app.toast("Replay only — your live campaigns weren't touched.", "shield");
  }, [app]);

  const savedLabel = "$" + saved.toLocaleString("en-US");
  const visible = EVENTS.slice(0, step);

  return (
    <div className="cd-screen" data-screen-label="Calderyn Labs">
      <div className="cd-labbar">
        <span className="dot" />
        <span>Calderyn Labs · Autopilot replay</span>
        <button type="button" className="cd-labbar-replay" onClick={replay}>
          <CDIcon name="rotate" size={13} strokeWidth={2.2} />
          Replay
        </button>
        <button
          type="button"
          className="cd-labbar-exit"
          onClick={() => app.navigate("campaigns")}
        >
          Exit ›
        </button>
      </div>

      <header className="cd-screen-head">
        <div>
          <h1 className="cd-h1">Campaigns</h1>
          <p className="cd-sub">
            $12,480 spent across 7 days · true ROAS 1.8× (margin-adjusted)
          </p>
        </div>
        <div className="cd-seg">
          <button type="button" className="cd-seg-btn" data-active="1">
            All
          </button>
          <button type="button" className="cd-seg-btn">
            Meta
          </button>
          <button type="button" className="cd-seg-btn">
            Google
          </button>
          <button type="button" className="cd-seg-btn">
            TikTok
          </button>
        </div>
      </header>

      <div className="cd-agentic">
        <div className="cd-agentic-head">
          <span className="cd-auto-badge">
            <span className="cd-auto-ring" />
            Autopilot acted on its own · 2 min ago
          </span>
          <h2 className="cd-agentic-title">
            <span style={{ color: "var(--red)" }}>Product sold out</span>
            <CDIcon name="arrowRight" className="cd-arr" size={22} strokeWidth={2.4} />
            <span>Calderyn paused the ads</span>
          </h2>
          <p className="cd-body" style={{ maxWidth: "54ch", color: "var(--text-2)" }}>
            <b style={{ color: "var(--text-1)" }}>Summit Logo Tee — M</b> hit zero stock
            — Calderyn paused its $480/day Meta campaign 38 seconds later, on its own.
          </p>
        </div>

        <div className="cd-metrics">
          <div className="cd-metric">
            <span
              className="cd-metric-val tabular-nums"
              style={{ color: "var(--green)" }}
            >
              {savedLabel}
            </span>
            <span className="cd-metric-lab">Wasted spend prevented</span>
          </div>
          <div className="cd-metric">
            <span className="cd-metric-val tabular-nums">38s</span>
            <span className="cd-metric-lab">Sold-out → paused</span>
          </div>
          <div className="cd-metric">
            <span
              className="cd-metric-val tabular-nums"
              style={{ display: "inline-flex", alignItems: "center" }}
            >
              $480
              <CDIcon name="arrowRight" className="cd-arr-sm" size={14} strokeWidth={2.6} />
              $0
            </span>
            <span className="cd-metric-lab">Daily budget</span>
          </div>
          <div className="cd-metric">
            <span className="cd-metric-val tabular-nums">312</span>
            <span className="cd-metric-lab">Out-of-stock clicks blocked</span>
          </div>
        </div>

        <div className="cd-timeline">
          {visible.map((ev, i) => (
            <div className="cd-tl-row" key={i}>
              <span className="cd-tl-ico" data-tone={ev.tone}>
                <CDIcon name={ev.icon} size={16} strokeWidth={1.85} />
              </span>
              <div className="cd-tl-body">
                <div className="cd-tl-title">{ev.title}</div>
                <div className="cd-tl-sub">{ev.sub}</div>
              </div>
              <span className="cd-tl-time">{ev.t}</span>
            </div>
          ))}
        </div>

        {flipped && (
          <div className="cd-flipcard">
            <span className="cd-platform">Me</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="cd-row-title">Summit Tee — Prospecting</span>
                <span
                  className="cd-badge"
                  style={{ background: "var(--gray-bg)", color: "var(--text-2)" }}
                >
                  ⏸ Paused by Calderyn
                </span>
              </div>
              <div className="cd-caption tabular-nums">
                <span className="cd-strike">$480/day</span>
                <CDIcon
                  name="arrowRight"
                  className="cd-arr-sm"
                  size={14}
                  strokeWidth={2.6}
                />
                $0/day · Meta · reversible
              </div>
            </div>
            <span className="cd-feed-icon" data-tone="success">
              <CDIcon name="check" size={16} strokeWidth={2} />
            </span>
          </div>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "16px 22px 18px",
            flexWrap: "wrap",
          }}
        >
          <button type="button" className="cd-btn cd-btn-primary" onClick={undoResume}>
            <CDIcon name="undo" size={15} strokeWidth={2} />
            Undo &amp; resume
          </button>
          <span
            className="cd-caption"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              marginLeft: "auto",
            }}
          >
            <CDIcon name="shield" size={13} strokeWidth={1.8} />
            Logged to action history · fully reversible
          </span>
        </div>
      </div>

      <div className="cd-card">
        <div className="cd-rows">
          <button
            type="button"
            className="cd-row"
            onClick={() => app.navigate("campaigns")}
          >
            <span className="cd-platform">Go</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="cd-row-title">Brand Search — Exact</span>
                <span
                  className="cd-badge"
                  style={{ background: "var(--green-bg)", color: "var(--green)" }}
                >
                  A
                </span>
              </div>
              <div className="cd-caption tabular-nums">
                $220/day · $1,540 spent (7d) · break-even 1.5×
              </div>
            </div>
            <div style={{ textAlign: "right", width: 64 }}>
              <div className="cd-row-num tabular-nums" style={{ color: "var(--green)" }}>
                4.6×
              </div>
              <div className="cd-caption">ROAS 7d</div>
            </div>
          </button>
          <button
            type="button"
            className="cd-row"
            onClick={() => app.navigate("campaigns")}
          >
            <span className="cd-platform">Me</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="cd-row-title">Retargeting — 30d viewers</span>
                <span
                  className="cd-badge"
                  style={{ background: "var(--red-bg)", color: "var(--red)" }}
                >
                  D
                </span>
              </div>
              <div className="cd-caption tabular-nums">
                $140/day · $980 spent (7d) · break-even 1.6×
              </div>
            </div>
            <div style={{ textAlign: "right", width: 64 }}>
              <div className="cd-row-num tabular-nums" style={{ color: "var(--red)" }}>
                1.1×
              </div>
              <div className="cd-caption">ROAS 7d</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
