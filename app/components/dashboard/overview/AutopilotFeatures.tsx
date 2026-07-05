// The Autopilot feature switchboard: every move Calderyn can make, grouped by
// domain — unlocked pairs render live autonomy toggles, still-training pairs
// show their graduation progress, and the rest of the catalog sits locked until
// the store earns it. This card is the merchant's per-feature on/off surface;
// the sidebar switch remains the master kill switch.
import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { CDIcon } from "../icons";
import { Toggle } from "../ui";
import { reduced } from "../hero/hero-motion";
import type { DashboardCtx } from "../context";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import type { FeatureGroupVM, FeatureRowVM } from "./features-model";
import { countEnabled, countTotal, LOCKED_FEATURE_TOOLTIP } from "./features-model";

const PROGRESS_TOOLTIP =
  "Still training: the switch records your preference now, and the feature starts running unattended once it finishes proving itself.";

function FeatureToggleRow({ row, app }: { row: FeatureRowVM; app: DashboardCtx }) {
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

  if (row.locked) {
    return (
      <div className="cd-apfeat" data-locked="1" title={LOCKED_FEATURE_TOOLTIP}>
        <span className="cd-apfeat-name">{row.name}</span>
        <CDIcon name="lock" size={15} className="cd-apfeat-lock" />
      </div>
    );
  }

  return (
    <div className="cd-apfeat" data-on={on ? "1" : "0"} title={row.watching ?? undefined}>
      <span className="cd-apfeat-name">{row.name}</span>
      {row.recommended && !on && <span className="cd-le-feat-recommend">Ready to turn on</span>}
      {row.progress && (
        <span
          className="cd-caption tabular-nums"
          style={{ whiteSpace: "nowrap", flexShrink: 0 }}
          title={PROGRESS_TOOLTIP}
        >
          {row.progress.done}/{row.progress.needed} {row.progress.unit}
        </span>
      )}
      <Toggle value={on} onChange={toggle} disabled={busy} ariaLabel={`${row.name} on/off`} />
    </div>
  );
}

function FeatureGroup({ group, app }: { group: FeatureGroupVM; app: DashboardCtx }) {
  const [collapsed, setCollapsed] = useState(group.onCount === 0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const hydrated = useRef(false);

  // Auto-expand when a group gains its first active feature (e.g. a pair just
  // graduated and the 45s poll rebuilt the groups) so the new toggle isn't
  // hidden behind a stale collapsed state. Manual collapses still stick until
  // the active count changes again.
  useEffect(() => {
    if (group.onCount > 0) setCollapsed(false);
  }, [group.onCount]);

  // Fold/unfold the body by animating real height (the chevron rotation is
  // CSS). First paint and reduced motion snap; an expand settles on height:auto
  // so rows added later by the poll never clip against a frozen pixel height.
  useGSAP(
    () => {
      const el = bodyRef.current;
      if (!el) return;
      if (!hydrated.current || reduced()) {
        hydrated.current = true;
        gsap.set(el, { height: collapsed ? 0 : "auto" });
        return;
      }
      if (collapsed) {
        gsap.to(el, { height: 0, duration: 0.28, ease: "power3.inOut", overwrite: true });
      } else {
        gsap.to(el, {
          height: "auto",
          duration: 0.32,
          ease: "power3.inOut",
          overwrite: true,
          onComplete: () => gsap.set(el, { height: "auto" }),
        });
      }
    },
    { dependencies: [collapsed] },
  );

  return (
    <>
      <button
        type="button"
        className="cd-apgrp"
        data-has-on={group.onCount > 0 ? "1" : "0"}
        data-collapsed={collapsed ? "1" : "0"}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="cd-apgrp-ico">
          <CDIcon name={group.icon} size={13} strokeWidth={2} />
        </span>
        <span className="cd-apgrp-name">{group.label}</span>
        <span className="cd-apgrp-count">
          {group.onCount} / {group.total}
        </span>
        <CDIcon name="chevronDown" size={15} className="cd-apgrp-chev" />
      </button>
      <div ref={bodyRef} className="cd-apgrp-body" data-collapsed={collapsed ? "1" : "0"}>
        {group.rows.map((r) => (
          <FeatureToggleRow key={`${r.detectorId}:${r.actionKind}`} row={r} app={app} />
        ))}
      </div>
    </>
  );
}

export default function AutopilotFeatures({ groups, app }: { groups: FeatureGroupVM[]; app: DashboardCtx }) {
  const onCount = countEnabled(groups);
  const totalRows = countTotal(groups);
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
      <div className="cd-pad-x cd-pad-t" style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 className="cd-h2" style={{ margin: 0 }}>
            Autopilot features
          </h2>
          <div className="cd-caption" style={{ marginTop: 2 }}>
            Each switch is one move Calderyn can make on its own.
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
      <div data-apfeat-scroll style={{ maxHeight: 420, overflowY: "auto", paddingBottom: 6 }}>
        {totalRows === 0 ? (
          <div className="cd-apfeat" style={{ color: "var(--text-3)" }}>
            <span className="cd-apfeat-name" style={{ color: "var(--text-3)" }}>
              Approve suggestions to unlock autopilot features.
            </span>
          </div>
        ) : (
          groups.map((g) => <FeatureGroup key={g.key} group={g} app={app} />)
        )}
      </div>
    </div>
  );
}
