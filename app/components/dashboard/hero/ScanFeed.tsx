import { useEffect, useRef, useState } from "react";
import type { ScanItem } from "../../../lib/calibration/live-engine-types";

// Vertical "scan" ticker for a Watching-row middle slot: cycles a group's
// monitored items one line at a time so it reads as the agent scanning them
// live. Motion uses the Web Animations API (no GSAP, no layout reads during
// render); all setup is in an effect with cleanup. Honors prefers-reduced-motion.

const LINE_H = 18;
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

export type ScanState = "scan" | "flag" | "off";

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

export default function ScanFeed({
  items,
  state,
  flagText,
  emptyText,
}: {
  items: ScanItem[];
  state: ScanState;
  flagText?: string;
  emptyText?: string;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const rolling = state === "scan" && items.length >= 2 && !reduced;

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !rolling) return;
    const n = items.length;
    let i = 0;
    let anim: Animation | null = null;
    let timer: number | undefined;
    const tick = () => {
      i += 1;
      // Drop the previous (forwards-filled) animation before starting the next
      // so finished Animation objects don't accumulate on the element over a
      // long-lived session. The new keyframes set the start position the same
      // frame, so there's no flash.
      anim?.cancel();
      anim = strip.animate(
        [
          { transform: `translateY(${-(i - 1) * LINE_H}px)` },
          { transform: `translateY(${-i * LINE_H}px)` },
        ],
        { duration: 550, easing: EASE, fill: "forwards" },
      );
      anim.onfinish = () => {
        if (i >= n) {
          // The appended duplicate of items[0] is now showing; snap back with
          // no transition so the wrap is seamless.
          i = 0;
          strip.style.transform = "translateY(0)";
          anim?.cancel();
        }
        // Randomised hold desyncs rows from each other.
        timer = window.setTimeout(tick, 1700 + Math.random() * 600);
      };
    };
    strip.style.transform = "translateY(0)";
    timer = window.setTimeout(tick, 900 + Math.random() * 1300);
    return () => {
      anim?.cancel();
      if (timer) clearTimeout(timer);
    };
  }, [items, rolling]);

  if (state === "flag") {
    // A flagged row never shows the ambient ticker, even if flag text is missing.
    return (
      <div className="cd-scanwin" data-watch-scan>
        <div className="cd-scanline">
          <span className="cd-scanline-label cd-scanflag">{flagText || "Needs your review"}</span>
        </div>
      </div>
    );
  }

  if (state === "off" || items.length === 0) {
    return (
      <div className="cd-scanwin" data-watch-scan>
        <div className="cd-scanline">
          <span className="cd-scanline-label cd-scandim">{emptyText ?? ""}</span>
        </div>
      </div>
    );
  }

  // Append a duplicate of the first item so the wrap from last → first reads as
  // one continuous roll. Reduced motion / single item: render one static line.
  const lines = rolling ? [...items, items[0]] : [items[0]];

  return (
    <div className="cd-scanwin" data-watch-scan>
      <div className="cd-scanstrip" ref={stripRef}>
        {lines.map((it, idx) => (
          <div className="cd-scanline" key={idx}>
            <span className="cd-scanline-label">{it.label}</span>
            {it.value ? <span className="cd-scanline-val">{it.value}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
