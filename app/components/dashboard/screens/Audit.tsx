import { useState, type ReactNode } from "react";
import { Card, Pill, Btn, Placeholder, TableSkeleton } from "../ui";
import { CDIcon, CD_ACTION_ICON } from "../icons";
import { money, timeAgo, absTime } from "../format";
import { recovered } from "~/lib/recovered";
import { COST_SOURCE_LABELS } from "~/lib/labels";
import type { DashboardCtx } from "../context";
import type { AuditVM } from "../view-models";

/* ---------- Header ---------- */
function ScreenHeader({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <header className="cd-screen-head" data-screen-label={title}>
      <div>
        <h1 className="cd-h1">{title}</h1>
        {sub && <p className="cd-sub">{sub}</p>}
      </div>
    </header>
  );
}

/* ---------- Single history row (punch list) ---------- */
function AuditRow({ entry, app }: { entry: AuditVM; app: DashboardCtx }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const failed = entry.outcome === "failed";
  const undone =
    Boolean((entry as AuditVM & { undone?: boolean }).undone) || entry.post === "Reverted";

  const onUndo = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await app.undoAction(entry);
    } finally {
      setBusy(false);
    }
  };

  // Punch-list tint maps the REAL outcome vocabulary (succeeded | failed |
  // retrying): succeeded → done, failed/undone → need, retrying → prog.
  const k = failed || undone ? "need" : entry.outcome === "succeeded" ? "done" : "prog";
  const iconName = failed ? "warn" : CD_ACTION_ICON[entry.action_kind] ?? "bolt";
  const showImpact = entry.dollar_impact_at_exec > 0 && !undone;

  // Sub line: in-flight/undone state word first (all from the VM), then the
  // action detail (falling back to the legibility trigger when detail is
  // empty), the actor, and the booked dollar impact when nonzero — always
  // with its margin-basis qualifier so an estimate never reads as measured.
  const status = failed
    ? null // failed rows carry their failure reason on a dedicated line below
    : undone
      ? "Undone"
      : entry.outcome === "retrying"
        ? "Retrying"
        : null;
  const subParts = [
    status,
    entry.detail || entry.why,
    entry.actorDisplay,
    showImpact
      ? `+${money(entry.dollar_impact_at_exec)}${entry.marginBasisLabel ? ` (${entry.marginBasisLabel.toLowerCase()})` : ""}`
      : null,
  ].filter((p): p is string => Boolean(p));

  return (
    <>
      <div className="cd-punch-row">
        <span className="cd-punch-ico" data-k={k}>
          <CDIcon name={iconName} size={16} strokeWidth={1.9} />
        </span>
        <button
          type="button"
          className="cd-punch-body"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Hide details" : "Show details"}
          style={{
            background: "transparent",
            border: 0,
            padding: 0,
            textAlign: "left",
            cursor: "pointer",
            font: "inherit",
            color: "inherit",
          }}
        >
          <div className="cd-punch-title">
            {entry.undo_of ? "Reversed — " : ""}
            {entry.verb}
            {entry.target ? ` — ${entry.target}` : ""}
          </div>
          <div className="cd-punch-sub">{subParts.join(" · ")}</div>
          {/* A failed row must surface WHY it failed without needing expansion
              (rule 12 — fail visibly). The legibility `why` is the trigger, not
              the failure, so show the machine failure message too. */}
          {failed && (
            <div className="cd-punch-sub" style={{ color: "var(--red)" }}>
              {entry.failureFriendly ?? entry.failure ?? "Failed"}
            </div>
          )}
        </button>
        <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
          {entry.action_kind === "create_po_draft" && !failed && (
            <a
              href={`/dashboard/api/audit/${encodeURIComponent(entry.id)}/po.pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="cd-link"
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <CDIcon name="doc" size={13} strokeWidth={1.9} /> PDF
            </a>
          )}
          {entry.undo_eligible && !undone && (
            <Btn small icon="undo" disabled={busy} onClick={onUndo}>
              {busy ? "Undoing…" : "Undo"}
            </Btn>
          )}
          <span
            className="cd-eftime"
            style={{ color: "var(--text-3)" }}
            title={absTime(entry.when) || undefined}
          >
            {timeAgo(entry.when)}
          </span>
        </div>
      </div>
      {open && (
        <div className="cd-audit-detail">
          <div className="cd-kv-col">
            <div className="cd-kv">
              <span>Why this fired</span>
              <b>{entry.whyDetail ?? entry.why}</b>
            </div>
            {entry.failure && (
              <div className="cd-kv">
                <span>Failure reason</span>
                <b style={{ color: "var(--red)" }}>{entry.failure}</b>
              </div>
            )}
            {showImpact && (
              <div className="cd-kv">
                <span>Booked margin</span>
                <b>
                  +{money(entry.dollar_impact_at_exec)} · {entry.marginBasisLabel}
                </b>
              </div>
            )}
            {entry.costLineage.length > 0 && (
              <div className="cd-kv">
                <span>Cost lineage</span>
                <span className="flex items-center gap-1" style={{ flexWrap: "wrap" }}>
                  {entry.costLineage.map((s, i) => (
                    <Pill key={i} tone={s.source === "unavailable" ? "warn" : "neutral"}>
                      {costKindLabel(s.kind)}: {COST_SOURCE_LABELS[s.source] ?? s.source}
                    </Pill>
                  ))}
                </span>
              </div>
            )}
          </div>
          {entry.stateDiff.length > 0 && (
            <>
              <div className="cd-audit-diff-head">Before → after</div>
              <div className="cd-evidence">
                {entry.stateDiff.map((r) => (
                  <div key={r.label} className="cd-evidence-cell">
                    <div className="cd-caption">{r.label}</div>
                    <div className="cd-h3 tabular-nums">
                      {r.before != null && r.after != null ? (
                        <>
                          {r.before}
                          <span className="cd-diff-arrow">→</span>
                          {r.after}
                        </>
                      ) : (
                        r.after ?? r.before
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

function costKindLabel(kind: string): string {
  return kind === "ad_spend" ? "Ad spend" : kind === "cogs" ? "COGS" : "Price";
}

export default function Audit({ app }: { app: DashboardCtx }) {
  const audit = app.audit;
  // Same shared computation as the Overview tile and the embedded extension
  // (app/lib/recovered.ts): succeeded actions, undo rows excluded.
  const recoveredCents = recovered(audit).cents;

  const loading = app.loading && audit.length === 0;

  return (
    <div className="cd-screen">
      <ScreenHeader
        title="Action history"
        sub={
          loading
            ? "Loading every action Calderyn and you have taken…"
            : `Every action Calderyn or you took — ${money(recoveredCents)} recovered, all reversible where possible.`
        }
      />
      <Card pad={false}>
        {loading ? (
          <TableSkeleton />
        ) : audit.length === 0 ? (
          <Placeholder
            icon="clock"
            title="No actions yet"
            sub="When Calderyn or you act on an alert, it gets logged here — reversible where possible."
          />
        ) : (
          <div style={{ padding: "6px 0" }}>
            {audit.map((e) => (
              <AuditRow key={e.id} entry={e} app={app} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
