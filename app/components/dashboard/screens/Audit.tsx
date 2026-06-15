// Calderyn DashV2 — Action history screen (LIVE).
// Ported from the "Action history" section of the prototype's screen-ops.jsx,
// wired to the live DashboardCtx. Renders every action Calderyn or the merchant
// took (from app.audit) with an action icon, verb/target, detail, actor + when,
// a dollar-impact figure, outcome pills (Blocked / Undone), and an Undo button
// when the entry is undo-eligible. Undo goes through app.undoAction(); the shell
// handles the toast + refresh, so the row flips to "Undone" on the next refresh.
import { useState, type ReactNode } from "react";
import { Card, Pill, Btn, Placeholder } from "../ui";
import { CDIcon, CD_ACTION_ICON } from "../icons";
import { money, timeAgo, absTime } from "../format";
import { recovered } from "~/lib/recovered";
import { COST_SOURCE_LABELS } from "~/lib/labels";
import type { DashboardCtx } from "../context";
import type { AuditVM } from "../view-models";

/* ---------- Header (mirrors the prototype's ScreenHeader) ---------- */
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

/* ---------- Single history row ---------- */
function AuditRow({ entry, app }: { entry: AuditVM; app: DashboardCtx }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const failed = entry.outcome === "failed";
  const retrying = entry.outcome === "retrying";
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

  const tone = failed ? "critical" : entry.mode === "auto" ? "accent" : "success";
  const iconName = failed ? "warn" : CD_ACTION_ICON[entry.action_kind] ?? "bolt";
  const showImpact = entry.dollar_impact_at_exec > 0 && !undone;

  return (
    <div className="cd-row" data-dim={failed ? "1" : "0"} style={{ flexWrap: "wrap" }}>
      <button
        className="cd-feed-icon"
        data-tone={tone}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "Hide details" : "Show details"}
        style={{ border: 0, cursor: "pointer", background: "transparent" }}
      >
        <CDIcon name={open ? "chevronDown" : "chevronRight"} size={14} strokeWidth={1.9} />
      </button>
      <span className="cd-feed-icon" data-tone={tone}>
        <CDIcon name={iconName} size={14} strokeWidth={1.9} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Pill tone={entry.mode === "auto" ? "accent" : "neutral"}>
            {entry.mode === "auto" ? "Auto" : "Manual"}
          </Pill>
          <span className="cd-row-title truncate">
            {entry.undo_of ? "Reversed — " : ""}
            {entry.verb} — {entry.target}
          </span>
          {failed && <Pill tone="critical" icon="x">Blocked</Pill>}
          {retrying && <Pill tone="warn" icon="clock">Retrying</Pill>}
          {undone && <Pill icon="undo">Undone</Pill>}
        </div>
        <div className="cd-caption truncate">{entry.why}</div>
        {/* A failed row must surface WHY it failed without needing expansion
            (rule 12 — fail visibly). The legibility `why` is the trigger, not
            the failure, so show the machine failure message too. */}
        {failed && entry.failure && (
          <div className="cd-caption truncate" style={{ color: "var(--red)" }}>
            {entry.failure}
          </div>
        )}
      </div>
      <div className="text-right whitespace-nowrap">
        {showImpact && (
          <div className="cd-row-num tabular-nums" style={{ color: "var(--green)" }}>
            +{money(entry.dollar_impact_at_exec)}
          </div>
        )}
        {showImpact && <div className="cd-caption">{entry.marginBasisLabel}</div>}
        <div className="cd-caption" title={absTime(entry.when) || undefined}>
          {entry.actorDisplay} · {timeAgo(entry.when)}
        </div>
      </div>
      {entry.undo_eligible && !undone && (
        <Btn small icon="undo" disabled={busy} onClick={onUndo}>
          {busy ? "Undoing…" : "Undo"}
        </Btn>
      )}
      {open && (
        <div className="cd-audit-detail" style={{ flexBasis: "100%", paddingLeft: 32, paddingTop: 8 }}>
          <DetailBlock label="Why this fired">{entry.whyDetail ?? entry.why}</DetailBlock>
          {entry.failure && <DetailBlock label="Failure reason">{entry.failure}</DetailBlock>}
          {showImpact && (
            <DetailBlock label="Booked margin">
              +{money(entry.dollar_impact_at_exec)} · {entry.marginBasisLabel}
            </DetailBlock>
          )}
          {entry.costLineage.length > 0 && (
            <DetailBlock label="Cost lineage">
              <span className="flex items-center gap-1" style={{ flexWrap: "wrap" }}>
                {entry.costLineage.map((s, i) => (
                  <Pill key={i} tone={s.source === "unavailable" ? "warn" : "neutral"}>
                    {s.kind === "ad_spend" ? "Ad spend" : s.kind === "cogs" ? "COGS" : "Price"}:{" "}
                    {COST_SOURCE_LABELS[s.source] ?? s.source}
                  </Pill>
                ))}
              </span>
            </DetailBlock>
          )}
          {entry.pre !== "—" && (
            <DetailBlock label="Before → after">
              {entry.pre} → {entry.post}
            </DetailBlock>
          )}
        </div>
      )}
    </div>
  );
}

function DetailBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <span className="cd-caption" style={{ fontWeight: 600 }}>{label}: </span>
      <span className="cd-caption">{children}</span>
    </div>
  );
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
          <Placeholder icon="clock" title="Loading action history" sub="Pulling every automated and manual action." />
        ) : audit.length === 0 ? (
          <Placeholder
            icon="clock"
            title="No actions yet"
            sub="When Calderyn or you act on an alert, it gets logged here — reversible where possible."
          />
        ) : (
          <div className="cd-rows">
            {audit.map((e) => (
              <AuditRow key={e.id} entry={e} app={app} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
