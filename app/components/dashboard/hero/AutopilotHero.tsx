import { useRef, useEffect, type CSSProperties } from "react";
import { useGSAP } from "@gsap/react";
import { money } from "../format";
import { HeroEngine } from "./hero-motion";
import ScanFeed from "./ScanFeed";
import { onEngine, type WatchGroup } from "../engine-events";
import type { ScanItem } from "../../../lib/calibration/live-engine-types";

export interface AutopilotHeroProps {
  /** watching | running — drives the title crossfade + Acting card. */
  running: boolean;
  /** Active autopilot features (drives the hex meter + "N active"). */
  featureOn: number;
  featureTotal: number;
  /** Calibration headline 0-100 and 1-of-N level. */
  calibrationPct: number | null;
  level: number;
  levels: number;
  /** "$ protected this week" in cents. */
  moneyProtectedCents: number;
  /** Watching groups that currently hold a pending (flagged) item. */
  flaggedGroups: Set<WatchGroup>;
  /** Real items being scanned per group; drives the per-row roll ticker. */
  watchScan: { inv: ScanItem[]; ads: ScanItem[]; price: ScanItem[]; ret: ScanItem[] };
  /** Plain-language flag text per group, shown when that group has a pending item. */
  watchFlags?: Partial<Record<WatchGroup, string>>;
  dark?: boolean;
}

const WATCH_GROUPS: { key: WatchGroup; label: string; icon: JSX.Element }[] = [
  {
    key: "inv",
    label: "Inventory",
    icon: (
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16.5 9.4 7.5 4.21" />
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
      </svg>
    ),
  },
  {
    key: "ads",
    label: "Ads",
    icon: (
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m3 11 18-5v12L3 14v-3z" />
        <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
      </svg>
    ),
  },
  {
    key: "price",
    label: "Pricing",
    icon: (
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
        <circle cx="7" cy="7" r="1.4" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    key: "ret",
    label: "Retention",
    icon: (
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
];

/** Dim line shown in a Watching row when a group has no real items to scan. */
const EMPTY_TEXT: Record<WatchGroup, string> = {
  inv: "No inventory to scan yet",
  ads: "No campaigns to scan yet",
  price: "No products to price-check yet",
  ret: "Retention monitoring coming soon",
};

function calNote(level: number, levels: number): string {
  return level >= levels
    ? `Level ${level} of ${levels} &middot; fully<br>calibrated`
    : `Level ${level} of ${levels} &middot; approvals<br>unlock more autopilot`;
}

const WATCH_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: "8px 11px",
  borderRadius: 9,
  background: "var(--ha-surface)",
  border: "1px solid var(--ha-line-2)",
  position: "relative",
  overflow: "hidden",
  transition: "border-color .35s ease,background .35s ease,opacity .35s ease",
};
const WATCH_ICO: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: 6,
  flex: "0 0 auto",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--ha-fill)",
  color: "var(--ha-ink-2)",
  position: "relative",
  zIndex: 1,
};

export default function AutopilotHero(props: AutopilotHeroProps) {
  const { running, featureOn, featureTotal, calibrationPct, level, levels, moneyProtectedCents, flaggedGroups, watchScan, watchFlags, dark } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<HeroEngine | null>(null);

  useGSAP(
    () => {
      const root = rootRef.current;
      if (!root) return;
      const engine = new HeroEngine(root);
      engineRef.current = engine;
      // Default-open on the Overview so Watching/Acting is the centerpiece.
      engine.setReasonInitial(true);
      engine.updateMeter(featureOn, featureTotal, false);
      engine.updateCalibration(calibrationPct ?? 0, calNote(level, levels), false);
      engine.setTitle(running);
      engine.setFlags(flaggedGroups);
      engine.startWatch();

      const offDock = onEngine("le-dock", (d) => d && engine.dock(d));
      const offOpen = onEngine("le-openreason", () => engine.openReason());
      const offCal = onEngine("le-calibrate", (d) => d && engine.bumpCalibration(d.kind, d.kind === "deny" ? `Level ${level} of ${levels} &middot; noted, refining` : calNote(level, levels)));

      return () => {
        offDock();
        offOpen();
        offCal();
        engine.destroy();
        engineRef.current = null;
      };
    },
    { scope: rootRef, dependencies: [] },
  );

  // Reactive updates when real data lands (after a refresh / poll).
  useEffect(() => { engineRef.current?.updateMeter(featureOn, featureTotal); }, [featureOn, featureTotal]);
  useEffect(() => { engineRef.current?.updateCalibration(calibrationPct ?? 0, calNote(level, levels)); }, [calibrationPct, level, levels]);
  useEffect(() => { engineRef.current?.setTitle(running); }, [running]);
  useEffect(() => { engineRef.current?.setFlags(flaggedGroups); }, [flaggedGroups]);

  return (
    <div
      ref={rootRef}
      className="ha ha-fx"
      data-theme={dark ? "dark" : "light"}
      style={{
        position: "relative",
        overflow: "hidden",
        borderRadius: 20,
        padding: "24px 26px",
        color: "var(--ha-ink)",
        background: "var(--ha-bg)",
        boxShadow: "var(--ha-shadow)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <span className="ha-fx" style={{ position: "absolute", width: 320, height: 320, borderRadius: "50%", top: -130, right: 120, background: "var(--ha-glow1)", filter: "blur(22px)", pointerEvents: "none" }} />
      <span className="ha-drift" style={{ position: "absolute", width: 280, height: 280, borderRadius: "50%", bottom: -130, left: -50, background: "var(--ha-glow2)", filter: "blur(26px)", pointerEvents: "none" }} />

      {/* header row */}
      <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <span className="ha-fx" style={{ flex: "0 0 auto", display: "inline-flex", filter: "drop-shadow(0 5px 12px rgba(0,0,0,.28))" }}>
            <svg width="50" height="50" viewBox="0 0 32 32" fill="none">
              <path className="ha-hexbase" d="M16 2.4 L27.86 9 L27.86 22.9 L16 29.6 L4.14 22.9 L4.14 9 Z" fill="#111113" stroke="rgba(255,255,255,.16)" strokeWidth="1.4" strokeLinejoin="round" />
              <path className="ha-hexprog" d="M16 2.4 L27.86 9 L27.86 22.9 L16 29.6 L4.14 22.9 L4.14 9 Z" pathLength={1} fill="none" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" strokeDasharray="1 1" strokeDashoffset={1} />
              <path className="ha-hexc" d="M24.4 11.15 L16 6.3 L7.6 11.15 L7.6 20.85 L16 25.7 L24.4 20.85" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinejoin="round" strokeLinecap="round" />
            </svg>
          </span>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
            <div style={{ fontSize: 18, fontWeight: 680, letterSpacing: "-.02em", whiteSpace: "nowrap" }}>
              Calderyn is&nbsp;
              <span style={{ position: "relative", display: "inline-block", overflow: "hidden", verticalAlign: "bottom", height: "1.3em" }}>
                {/* engine-owned: HeroEngine.setTitle fills + crossfades this so a
                    re-render never interrupts the animation. */}
                <span className="ha-word" data-state-word style={{ display: "inline-block", lineHeight: "1.3em" }} />
              </span>
            </div>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 600, color: "var(--ha-ink-3)", whiteSpace: "nowrap" }}>
              <span>
                <span data-live-count>{featureOn}</span>&nbsp;autopilot {featureOn === 1 ? "feature" : "features"} active
              </span>
            </span>
          </div>

          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 16 }}>
            {/* calibration ring */}
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ position: "relative", width: 46, height: 46, flex: "0 0 auto" }}>
                <svg width="46" height="46" viewBox="0 0 46 46" style={{ transform: "rotate(-90deg)" }}>
                  <circle cx="23" cy="23" r="19.5" fill="none" stroke="var(--ha-line-2)" strokeWidth="4" />
                  <circle data-cal-arc cx="23" cy="23" r="19.5" fill="none" stroke="var(--ha-ink)" strokeWidth="4" strokeLinecap="round" strokeDasharray="122.52" strokeDashoffset={122.52} />
                </svg>
                <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ha-ink)", lineHeight: 1 }}>
                  <span data-cal-pct style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-.03em" }}>0</span>
                  <span style={{ fontSize: 9, fontWeight: 700, color: "var(--ha-ink-3)", marginTop: -3 }}>%</span>
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontSize: 13, fontWeight: 680, letterSpacing: "-.01em", color: "var(--ha-ink)", lineHeight: 1 }}>Calibration</span>
                {/* engine-owned: HeroEngine.updateCalibration fills this. */}
                <span data-cal-note style={{ fontSize: 10.5, color: "var(--ha-ink-3)", lineHeight: 1.3 }} />
              </div>
            </div>
            <span style={{ alignSelf: "stretch", width: 1, background: "var(--ha-line-2)", margin: "2px 0", flex: "0 0 auto" }} />
            {/* money */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 11 }}>
                <div style={{ fontSize: 38, fontWeight: 700, letterSpacing: "-.035em", lineHeight: 1, fontVariantNumeric: "tabular-nums", textShadow: "var(--ha-money-shadow)" }}>{money(moneyProtectedCents)}</div>
              </div>
              <span style={{ fontSize: 11, color: "var(--ha-ink-2)" }}>protected this week</span>
            </div>
          </div>
        </div>
      </div>

      {/* reasoning panel */}
      <div style={{ position: "relative", zIndex: 1, marginTop: 4 }}>
        <button type="button" className="ha-reason-head" onClick={() => engineRef.current?.toggleReason()} style={{ display: "inline-flex", alignItems: "center", gap: 7, border: "none", background: "none", cursor: "pointer", color: "var(--ha-ink)", fontFamily: "inherit", padding: 0, textAlign: "left" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <span data-reason-label style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-.01em" }}>Hide reasoning</span>
          </span>
          <span data-reason-chev style={{ display: "inline-flex", color: "var(--ha-ink-1b)", transform: "rotate(180deg)" }}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
          </span>
        </button>
        <div data-reason-body style={{ height: "auto", overflow: "hidden" }}>
          <div style={{ paddingTop: 6, paddingBottom: 4, minHeight: 206, boxSizing: "border-box" }}>
            <div data-role="live" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,0.94fr)", gap: 14, alignItems: "stretch", minHeight: 188, position: "relative" }}>
              {/* watching column */}
              <div data-watch-col style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, marginBottom: 11 }}>
                  <span style={{ fontSize: 14, fontWeight: 660, letterSpacing: "-.01em", color: "var(--ha-ink)" }}>Watching</span>
                </div>
                {/* Watch rows render with STATIC styling/text; HeroEngine owns all
                    dynamic state (scan shimmer, flags, the dock sequence) so a
                    React re-render can never clobber an in-flight animation. */}
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {WATCH_GROUPS.map((g, i) => (
                    <div key={g.key} data-watch-row data-i={i} data-group={g.key} style={WATCH_ROW}>
                      <span data-watch-sweep style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: "55%", opacity: 0, background: "linear-gradient(90deg,transparent,var(--ha-line) 50%,transparent)", pointerEvents: "none" }} />
                      <span data-watch-ico style={WATCH_ICO}>{g.icon}</span>
                      <span style={{ flex: "0 0 auto", fontSize: 12.5, fontWeight: 600, color: "var(--ha-ink)", whiteSpace: "nowrap", position: "relative", zIndex: 1 }}>{g.label}</span>
                      <div style={{ flex: "1 1 auto", minWidth: 0, position: "relative", height: 18, overflow: "hidden", zIndex: 1 }}>
                        <ScanFeed
                          items={watchScan[g.key]}
                          state={flaggedGroups.has(g.key) ? "flag" : watchScan[g.key].length ? "scan" : "off"}
                          flagText={watchFlags?.[g.key]}
                          emptyText={EMPTY_TEXT[g.key]}
                        />
                        <span data-watch-sub style={{ display: "none", alignItems: "center", position: "absolute", inset: 0, fontSize: 11.5, fontWeight: 600, lineHeight: "18px", color: "var(--ha-flag)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} />
                      </div>
                      <span data-watch-stat style={{ display: "inline-flex", alignItems: "center", gap: 5, flex: "0 0 auto", fontSize: 10.5, fontWeight: 600, color: "var(--ha-ink-3)", position: "relative", zIndex: 1 }}>
                        <span data-watch-dot style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--ha-ink-3)", flex: "0 0 auto" }} />
                        <span data-watch-txt>All good</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* acting column */}
              <div data-act-col style={{ display: "flex", flexDirection: "column", minWidth: 0, background: "var(--ha-surface)", border: "1px solid var(--ha-line-2)", borderRadius: 14, padding: "13px 15px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 12 }}>
                  <span style={{ fontSize: 14, fontWeight: 660, letterSpacing: "-.01em", color: "var(--ha-ink)" }}>Acting</span>
                  <span data-act-state style={{ display: "inline-flex", alignItems: "center", fontSize: 9.5, fontWeight: 700, letterSpacing: ".07em", padding: "4px 9px", borderRadius: 999, background: "var(--ha-fill)", color: "var(--ha-ink-3)", whiteSpace: "nowrap" }}>STANDING BY</span>
                </div>
                <div data-act-card style={{ display: "flex", flexDirection: "column", gap: 11, minHeight: 158, position: "relative" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
                    <span data-act-ico style={{ width: 30, height: 30, borderRadius: 8, flex: "0 0 auto", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--ha-fill)", color: "var(--ha-ink-2)", marginTop: 1 }}>
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="4" y1="8" x2="20" y2="8" /><line x1="4" y1="12" x2="14" y2="12" /><line x1="4" y1="16" x2="17" y2="16" /></svg>
                    </span>
                    <span style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                      <span data-act-name style={{ fontSize: 13, fontWeight: 640, letterSpacing: "-.01em", color: "var(--ha-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Standing by</span>
                      <span data-act-why style={{ display: "none", fontSize: 11, fontWeight: 500, color: "var(--ha-ink-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} />
                    </span>
                  </div>
                  <div data-act-steps style={{ display: "flex", flexDirection: "column", gap: 7 }} />
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: "auto" }}>
                    <span data-act-money style={{ display: "none", alignItems: "baseline", gap: 0, fontSize: 11.5, fontWeight: 600, color: "var(--ha-ink-2)" }} />
                  </div>
                  <div data-act-prog style={{ display: "none" }}>
                    <span style={{ display: "block", height: 6, borderRadius: 99, background: "var(--ha-line-2)", overflow: "hidden" }}>
                      <span data-act-fill style={{ display: "block", height: "100%", width: "0%", borderRadius: 99, background: "var(--ha-accent)" }} />
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
