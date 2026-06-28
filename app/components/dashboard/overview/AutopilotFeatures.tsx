import { useEffect, useState } from "react";
import { CDIcon } from "../icons";
import { Toggle } from "../ui";
import type { DashboardCtx } from "../context";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import type { FeatureGroupVM, FeatureRowVM } from "./features-model";
import { countEnabled, countTotal, LOCKED_FEATURE_TOOLTIP } from "./features-model";

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
    <div className="cd-apfeat" data-on={on ? "1" : "0"}>
      <span className="cd-apfeat-name">{row.name}</span>
      {row.recommended && !on && <span className="cd-le-feat-recommend">Ready to turn on</span>}
      <Toggle value={on} onChange={toggle} disabled={busy} />
    </div>
  );
}

function FeatureGroup({ group, app }: { group: FeatureGroupVM; app: DashboardCtx }) {
  const [collapsed, setCollapsed] = useState(group.onCount === 0);

  // Auto-expand when a group gains its first active feature (e.g. a pair just
  // graduated and the 45s poll rebuilt the groups) so the new toggle isn't
  // hidden behind a stale collapsed state. Manual collapses still stick until
  // the active count changes again.
  useEffect(() => {
    if (group.onCount > 0) setCollapsed(false);
  }, [group.onCount]);

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
      <div className="cd-apgrp-body" data-collapsed={collapsed ? "1" : "0"} style={{ height: collapsed ? 0 : "auto" }}>
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
  return (
    <div className="cd-card" style={{ padding: 0 }}>
      <div className="cd-pad-x cd-pad-t flex items-center justify-between" style={{ gap: 8 }}>
        <div className="flex items-center gap-2">
          <h2 className="cd-h2">Autopilot features</h2>
        </div>
        <span className="cd-badge" style={{ background: "var(--accent-bg)", color: "var(--accent)" }}>
          {onCount} on
        </span>
      </div>
      <div data-apfeat-scroll style={{ maxHeight: 360, overflowY: "auto", paddingBottom: 6 }}>
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
