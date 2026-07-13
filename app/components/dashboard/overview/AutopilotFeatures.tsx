// The Autopilot feature switchboard: every move Calderyn can make, grouped by
// domain in a two-column grid — unlocked pairs render as toggle chips, and the
// still-locked catalog collapses into one quiet line per group so the card
// stays a glance, not a wall. This is the merchant's per-feature on/off
// surface; the sidebar switch remains the master kill switch.
import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { CDIcon } from "../icons";
import { reduced } from "../hero/hero-motion";
import type { DashboardCtx } from "../context";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import type { FeatureGroupVM, FeatureRowVM } from "./features-model";
import { countEnabled, countTotal, LOCKED_FEATURE_TOOLTIP } from "./features-model";

const PROGRESS_TOOLTIP =
  "Still training: the switch records your preference now, and the feature starts running unattended once it finishes proving itself.";

/** One unlocked feature as a toggle chip — the whole chip is the switch. */
function FeatureChip({ row, app }: { row: FeatureRowVM; app: DashboardCtx }) {
  const [on, setOn] = useState(row.enabled);
  const [busy, setBusy] = useState(false);
  useEffect(() => setOn(row.enabled), [row.enabled]);

  const toggle = async () => {
    if (busy) return;
    const next = !on;
    setOn(next); // optimistic
    setBusy(true);
    try {
      await client.toggleFeatureAutonomy({ detectorId: row.detectorId, actionKind: row.actionKind, enabled: next });
      app.refreshLiveEngine();
    } catch (err) {
      setOn(!next); // revert
      app.toast(err instanceof DashboardApiError ? err.message : "Could not update this feature.", "warn", "critical");
    } finally {
      setBusy(false);
    }
  };

  const hint = row.progress ? PROGRESS_TOOLTIP : (row.watching ?? undefined);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${row.name} on/off`}
      className="cd-fx-chip"
      data-on={on ? "1" : "0"}
      disabled={busy}
      title={hint}
      onClick={toggle}
    >
      <span className="cd-fx-chip-name">{row.name}</span>
      {row.recommended && !on && <span className="cd-fx-chip-ready">ready</span>}
      {row.progress && (
        <span className="cd-fx-chip-prog tabular-nums">
          {row.progress.done}/{row.progress.needed}
        </span>
      )}
      <span className="cd-toggle" data-on={on ? "1" : "0"} aria-hidden="true">
        <span className="cd-toggle-knob" />
      </span>
    </button>
  );
}

/** One domain cell: header, unlocked chips, and the locked tail folded into a
 *  single line ("N more unlock as calibration grows"). */
function FeatureGroupCell({ group, app }: { group: FeatureGroupVM; app: DashboardCtx }) {
  const [showLocked, setShowLocked] = useState(false);
  const unlocked = group.rows.filter((r) => !r.locked);
  const locked = group.rows.filter((r) => r.locked);

  return (
    <div className="cd-fx-cell">
      <div className="cd-fx-head">
        <span className="cd-fx-ico" data-has-on={group.onCount > 0 ? "1" : "0"}>
          <CDIcon name={group.icon} size={13} strokeWidth={2} />
        </span>
        <span className="cd-fx-label">{group.label}</span>
        {group.onCount > 0 && <span className="cd-fx-oncount tabular-nums">{group.onCount} on</span>}
      </div>

      {unlocked.length > 0 ? (
        <div className="cd-fx-chips">
          {unlocked.map((r) => (
            <FeatureChip key={`${r.detectorId}:${r.actionKind}`} row={r} app={app} />
          ))}
        </div>
      ) : (
        <div className="cd-fx-none">Nothing unlocked here yet.</div>
      )}

      {locked.length > 0 && (
        <>
          <button
            type="button"
            className="cd-fx-more"
            aria-expanded={showLocked}
            onClick={() => setShowLocked((s) => !s)}
          >
            <CDIcon name="lock" size={12} strokeWidth={2} />
            {locked.length} more unlock{locked.length === 1 ? "s" : ""} as calibration grows
            <CDIcon name="chevronDown" size={13} className="cd-fx-more-chev" data-open={showLocked ? "1" : "0"} />
          </button>
          {showLocked && (
            <div className="cd-fx-chips">
              {locked.map((r) => (
                <span
                  key={`${r.detectorId}:${r.actionKind}`}
                  className="cd-fx-chip"
                  data-lock="1"
                  title={LOCKED_FEATURE_TOOLTIP}
                >
                  <span className="cd-fx-chip-name">{r.name}</span>
                  <CDIcon name="lock" size={12} strokeWidth={2} />
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function AutopilotFeatures({ groups, app }: { groups: FeatureGroupVM[]; app: DashboardCtx }) {
  const onCount = countEnabled(groups);
  const totalRows = countTotal(groups);
  const unlockedRows = groups.reduce((n, g) => n + g.rows.filter((r) => !r.locked).length, 0);
  const badgeRef = useRef<HTMLSpanElement>(null);
  const prevOn = useRef(onCount);

  // The "N on" badge acknowledges a count change with the house number-pop
  // (same values as the hero's bumpCalibration). No card-level entrance: the
  // dashboard's screen-swap transition already animates arrival, and cached
  // tabs must paint instantly on revisit.
  useGSAP(
    () => {
      if (prevOn.current === onCount) return;
      prevOn.current = onCount;
      if (reduced() || !badgeRef.current) return;
      gsap.fromTo(
        badgeRef.current,
        { scale: 1.18 },
        { scale: 1, duration: 0.5, ease: "back.out(2.4)", overwrite: true, clearProps: "transform" },
      );
    },
    { dependencies: [onCount] },
  );

  return (
    <div className="cd-card" style={{ padding: 0 }}>
      <div className="cd-pad-x cd-pad-t" style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 className="cd-h2" style={{ margin: 0 }}>
            Autopilot features
          </h2>
          <div className="cd-caption" style={{ marginTop: 2 }}>
            Each switch is one move Calderyn can make on its own.
            {totalRows > 0 && (
              <span className="tabular-nums">
                {" "}
                {unlockedRows} of {totalRows} unlocked.
              </span>
            )}
          </div>
        </div>
        <span
          ref={badgeRef}
          className="cd-badge tabular-nums"
          style={{ background: "var(--accent-bg)", color: "var(--accent)", flexShrink: 0 }}
        >
          {onCount} on
        </span>
      </div>
      {totalRows === 0 ? (
        <div className="cd-fx-none" style={{ padding: "0 20px 18px" }}>
          Approve suggestions to unlock autopilot features.
        </div>
      ) : (
        <div className="cd-fx-grid">
          {groups
            .filter((g) => g.rows.length > 0)
            .map((g) => (
              <FeatureGroupCell key={g.key} group={g} app={app} />
            ))}
        </div>
      )}
    </div>
  );
}
