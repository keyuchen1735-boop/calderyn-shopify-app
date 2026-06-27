import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useFetcher, useRevalidator } from "@remix-run/react";
import { Text } from "@shopify/polaris";
import { fmtMoney } from "~/lib/format";
import { calibrationBand } from "~/lib/calibration/bands";
import AutopilotHero from "~/components/dashboard/hero/AutopilotHero";
import {
  domainForDetector,
  lockedCatalogForGroup,
  catalogName,
  LOCKED_FEATURE_TOOLTIP,
} from "~/components/dashboard/overview/features-model";
import type { WatchGroup } from "~/components/dashboard/engine-events";
import type {
  LiveEnginePageData,
  LiveEngineFeatureVM,
  PendingInspectorVM,
  TraceEventVM,
  TraceTag,
} from "~/lib/calibration/live-engine-page.server";
import type { ActionKind, RejectReason } from "~/lib/types";

/* Reply shape of the route action that handles the per-feature autonomy toggle.
   The view posts to whatever route mounts it, so this mirrors that contract. */
type ToggleResult = { ok: true; enabled: boolean } | { error: string };

/* Reply shape of /app/alerts/$id for an approve (kind) or deny (intent=reject). */
type AlertActionResult = { ok: boolean; toast?: { message: string; isError?: boolean } };

/* Quick deny reasons → real RejectReason codes (teaches the engine the same way
   the alert page's full picker does). */
const DENY_REASONS: { label: string; reason: RejectReason }[] = [
  { label: "Too risky", reason: "too_aggressive" },
  { label: "Wrong timing", reason: "wrong_timing" },
  { label: "Not enough proof", reason: "not_enough_data" },
  { label: "I handle this", reason: "i_handle_this" },
];

/* ---------- inline icons (stroke=currentColor so CSS color drives the tint) ---------- */
const sx = { display: "block" } as const;
type IP = { s?: number; w?: number };
function ICheck({ s = 14, w = 2.4 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} style={sx}><path d="M20 6 9 17l-5-5" /></svg>);
}
function ICheckCircle({ s = 15, w = 2.2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" style={sx}><circle cx="12" cy="12" r="9" /><path d="M8.5 12.2l2.4 2.4 4.6-5" /></svg>);
}
function IPause({ s = 15, w = 2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} style={sx}><rect x="7" y="5" width="3" height="14" rx="1" /><rect x="14" y="5" width="3" height="14" rx="1" /></svg>);
}
function IUp({ s = 15, w = 2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} style={sx}><path d="M5 16l5-5 3 3 6-7" /><path d="M16 7h4v4" /></svg>);
}
function IUndo({ s = 14, w = 2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} style={sx}><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>);
}
function IChevR({ s = 16, w = 2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} style={sx}><path d="M9 6l6 6-6 6" /></svg>);
}
function IChevL({ s = 15, w = 2.2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} style={sx}><path d="M15 6l-6 6 6 6" /></svg>);
}
function IChevDown({ s = 16, w = 2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" style={sx}><path d="m6 9 6 6 6-6" /></svg>);
}
function IBox({ s = 14, w = 2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" style={sx}><path d="M16.5 9.4 7.5 4.21" /><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></svg>);
}
function IMegaphone({ s = 14, w = 2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" style={sx}><path d="m3 11 18-5v12L3 14v-3z" /><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" /></svg>);
}
function ITag({ s = 14, w = 2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" style={sx}><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" /><circle cx="7" cy="7" r="1.4" fill="currentColor" stroke="none" /></svg>);
}
function IUsers({ s = 14, w = 2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" style={sx}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>);
}
function ILock({ s = 15, w = 2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" style={sx}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>);
}
function IAlert({ s = 15, w = 2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" style={sx}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>);
}

/* ---------- shared bits ---------- */
function LiveBadge() {
  return (
    <span className="engx-live">
      <span className="engx-live-dot" />
      Live
    </span>
  );
}

const TAG_LABEL: Record<TraceTag, string> = {
  AUTO: "AUTO",
  APPROVED: "APPROVED",
  UNDONE: "UNDONE",
  BLOCKED: "BLOCKED",
};

function tagIcon(tag: TraceTag): ReactNode {
  if (tag === "AUTO") return <ICheck />;
  if (tag === "APPROVED") return <ICheckCircle />;
  if (tag === "UNDONE") return <IUndo />;
  return <IPause />;
}

function featureIcon(actionKind: ActionKind): ReactNode {
  if (actionKind === "increase_campaign_budget" || actionKind === "reallocate_budget") return <IUp s={18} />;
  return <IPause s={18} />;
}

function moneyPill(t: TraceEventVM): { text: string; tone: "good" | "muted" } | null {
  if (t.tag === "BLOCKED" || t.moneyCents === 0) return null;
  if (t.tag === "AUTO") return { text: `${fmtMoney(t.moneyCents)} protected`, tone: "good" };
  if (t.tag === "UNDONE") return { text: `${fmtMoney(Math.abs(t.moneyCents))} reversed`, tone: "muted" };
  return { text: fmtMoney(t.moneyCents), tone: "good" };
}

/* ---------- 1. autopilot features (grouped by domain, mirrors the dashboard) ---------- */
function FeatureRow({ f, autopilotEnabled }: { f: LiveEngineFeatureVM; autopilotEnabled: boolean }) {
  const fetcher = useFetcher<ToggleResult>();
  const [on, setOn] = useState(f.enabled);

  // Sync from the server after revalidation; revert an optimistic flip on error.
  useEffect(() => setOn(f.enabled), [f.enabled]);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && "error" in fetcher.data) setOn(f.enabled);
  }, [fetcher.state, fetcher.data, f.enabled]);

  const pending = fetcher.state !== "idle";
  const active = autopilotEnabled && on;
  const toggle = () => {
    const next = !on;
    setOn(next);
    // No action url: posts to whichever route currently mounts this view.
    fetcher.submit(
      { intent: "toggle-feature", detectorId: f.detectorId, actionKind: f.actionKind, enabled: String(next) },
      { method: "post" },
    );
  };

  return (
    <div className="engx-feat" data-on={active}>
      <span className="engx-feat-ico">{featureIcon(f.actionKind)}</span>
      <div className="engx-feat-body">
        <div className="engx-feat-namerow">
          <span className="engx-feat-name">{f.name}</span>
          {active ? (
            <span className="engx-feat-active">
              <span className="engx-live-dot engx-live-dot--sm" />
              ACTIVE
            </span>
          ) : f.recommended && !on ? (
            <span className="engx-feat-recommend">Ready to turn on</span>
          ) : null}
        </div>
        <div className="engx-feat-sub">
          {f.watching} &middot; {f.lastText}
        </div>
        {f.recommended && !on ? (
          <Text as="p" variant="bodySm" tone="subdued">
            You&rsquo;ve approved this enough times. Turn it on to let Calderyn handle it for you.
          </Text>
        ) : !f.proven ? (
          <Text as="p" variant="bodySm" tone="subdued">
            Approved {f.approvals}/{f.approvalsNeeded} &middot; made money {f.outcomes}/{f.outcomesNeeded}. A few more good results and it can run on its own.
          </Text>
        ) : null}
      </div>
      {active && f.moneyCents > 0 && (
        <div className="engx-feat-money">
          <div className="engx-feat-money-amt">{fmtMoney(f.moneyCents)}</div>
          <div className="engx-feat-money-cap">{f.actions} in 90 days</div>
        </div>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${on ? "Turn off" : "Turn on"} autopilot for ${f.name}`}
        className="engx-toggle"
        data-on={on}
        disabled={pending}
        onClick={toggle}
      >
        <span className="engx-toggle-knob" />
      </button>
    </div>
  );
}

const GROUP_META: Record<WatchGroup, { label: string; icon: ReactNode }> = {
  ads: { label: "Ads & campaigns", icon: <IMegaphone /> },
  inv: { label: "Inventory", icon: <IBox /> },
  price: { label: "Pricing & promos", icon: <ITag /> },
  ret: { label: "Retention", icon: <IUsers /> },
};
const GROUP_ORDER: WatchGroup[] = ["ads", "inv", "price", "ret"];

/** Locked catalog feature — a capability this store hasn't unlocked yet. */
function LockedFeatureRow({ name }: { name: string }) {
  return (
    <div className="engx-feat" data-locked="true" title={LOCKED_FEATURE_TOOLTIP}>
      <span className="engx-feat-ico engx-feat-ico--locked"><ILock /></span>
      <div className="engx-feat-body">
        <span className="engx-feat-name engx-feat-name--locked">{name}</span>
      </div>
    </div>
  );
}

function FeatureGroupSection({
  label,
  icon,
  unlocked,
  locked,
  autopilotEnabled,
}: {
  label: string;
  icon: ReactNode;
  unlocked: LiveEngineFeatureVM[];
  locked: { detectorId: string; name: string }[];
  autopilotEnabled: boolean;
}) {
  const onCount = autopilotEnabled ? unlocked.filter((f) => f.enabled).length : 0;
  const total = unlocked.length + locked.length;
  const [collapsed, setCollapsed] = useState(onCount === 0);

  // Auto-expand when a group gains its first active feature (e.g. a pair just
  // graduated and a poll rebuilt the data) so the new toggle isn't hidden.
  useEffect(() => {
    if (onCount > 0) setCollapsed(false);
  }, [onCount]);

  return (
    <>
      <button type="button" className="engx-grp" onClick={() => setCollapsed((c) => !c)}>
        <span className="engx-grp-ico">{icon}</span>
        <span className="engx-grp-name">{label}</span>
        <span className="engx-grp-count">
          {onCount} / {total}
        </span>
        <span className="engx-grp-chev" data-collapsed={collapsed}>
          <IChevDown s={15} />
        </span>
      </button>
      {!collapsed && (
        <div className="engx-feat-list">
          {unlocked.map((f) => (
            <FeatureRow
              key={`${f.detectorId}:${f.actionKind}`}
              f={{ ...f, name: catalogName(f.detectorId, f.name) }}
              autopilotEnabled={autopilotEnabled}
            />
          ))}
          {locked.map((c) => (
            <LockedFeatureRow key={c.detectorId} name={c.name} />
          ))}
        </div>
      )}
    </>
  );
}

function AutopilotFeaturesCard({ data }: { data: LiveEnginePageData }) {
  const onCount = data.autopilotEnabled ? data.features.filter((f) => f.enabled).length : 0;
  const unlockedDetectors = new Set(data.features.map((f) => f.detectorId));
  const groups = GROUP_ORDER.map((key) => ({
    key,
    label: GROUP_META[key].label,
    icon: GROUP_META[key].icon,
    unlocked: data.features.filter((f) => domainForDetector(f.detectorId) === key),
    locked: lockedCatalogForGroup(key, unlockedDetectors),
  }));

  return (
    <div className="engx-auto">
      <div className="engx-feat-head">
        <h2 className="engx-auto-h2">Autopilot features</h2>
        <span className="engx-feat-head-badge">{onCount} on</span>
      </div>
      {groups.map((g) => (
        <FeatureGroupSection
          key={g.key}
          label={g.label}
          icon={g.icon}
          unlocked={g.unlocked}
          locked={g.locked}
          autopilotEnabled={data.autopilotEnabled}
        />
      ))}
    </div>
  );
}

/* ---------- 2a. Calderyn log (trace) ---------- */
function TraceRow({ t, selected, onSelect }: { t: TraceEventVM; selected: boolean; onSelect: () => void }) {
  const pill = moneyPill(t);
  return (
    <button type="button" className="engx-trace-row" data-tag={t.tag} data-selected={selected} onClick={onSelect}>
      <span className="engx-trace-ico">{tagIcon(t.tag)}</span>
      <span className="engx-trace-main">
        <span className="engx-trace-top">
          <span className="engx-trace-tag">{TAG_LABEL[t.tag]}</span>
          <span className="engx-trace-time">{t.rel || t.time}</span>
        </span>
        <span className="engx-trace-text">{t.text}</span>
        {pill && <span className={`engx-trace-money engx-trace-money--${pill.tone}`}>{pill.text}</span>}
      </span>
      <span className="engx-trace-chev">
        <IChevR />
      </span>
    </button>
  );
}

/* A flagged proposal in the log: NEEDS YOU, with inline approve / deny. Approve
   executes via /app/alerts/$id; deny records a rejection (teaches, runs nothing).
   A real success removes the row, then the parent revalidates. */
type PendingRowState = "idle" | "denying";

function PendingRow({
  p,
  selected,
  onSelect,
  onResolved,
}: {
  p: PendingInspectorVM;
  selected: boolean;
  onSelect: () => void;
  onResolved: (alertId: string) => void;
}) {
  const fetcher = useFetcher<AlertActionResult>();
  const [state, setState] = useState<PendingRowState>("idle");
  const busy = fetcher.state !== "idle";
  const error =
    fetcher.state === "idle" && fetcher.data && fetcher.data.ok === false
      ? fetcher.data.toast?.message ?? "Couldn't save that. Try the Alerts page."
      : null;

  // Resolve exactly once on the first successful approve/deny — the row then
  // leaves the list, so guard against a re-render firing onResolved again.
  const resolvedRef = useRef(false);
  useEffect(() => {
    if (resolvedRef.current) return;
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      resolvedRef.current = true;
      onResolved(p.alertId);
    }
  }, [fetcher.state, fetcher.data, onResolved, p.alertId]);

  const approve = () => {
    fetcher.submit({ kind: p.actionKind }, { method: "post", action: `/app/alerts/${p.alertId}` });
  };
  const deny = (reason: RejectReason) => {
    fetcher.submit({ intent: "reject", reason }, { method: "post", action: `/app/alerts/${p.alertId}` });
  };

  return (
    <div className="engx-trace-row" data-tag="REVIEW" data-pending="1" data-selected={selected}>
      <button type="button" className="engx-trace-rowmain" onClick={onSelect} title="See why Calderyn flagged this">
        <span className="engx-trace-ico">
          <IAlert />
        </span>
        <span className="engx-trace-main">
          <span className="engx-trace-top">
            <span className="engx-trace-tag">NEEDS YOU</span>
            <span className="engx-trace-time">{p.confidence}% confident</span>
          </span>
          <span className="engx-trace-text">{p.title}</span>
          <span className="engx-trace-money engx-trace-money--good">
            {fmtMoney(Math.abs(p.dollarImpactCents))} at stake &middot; will {p.actionLabel.toLowerCase()}
          </span>
        </span>
      </button>

      {state === "idle" && (
        <div className="engx-review-actions">
          <button type="button" className="engx-review-btn engx-review-btn--reject" disabled={busy} onClick={() => setState("denying")}>
            Deny
          </button>
          <button type="button" className="engx-review-btn engx-review-btn--accept" disabled={busy} onClick={approve}>
            {busy ? "Approving…" : "Approve"}
          </button>
        </div>
      )}

      {state === "denying" && (
        <div className="engx-deny-why">
          <span className="engx-deny-why-lab">Why are you turning this down?</span>
          <span className="engx-deny-chips">
            {DENY_REASONS.map((r) => (
              <button key={r.reason} type="button" className="engx-deny-chip" disabled={busy} onClick={() => deny(r.reason)}>
                {r.label}
              </button>
            ))}
          </span>
        </div>
      )}

      {error && <div className="engx-review-err">{error}</div>}
    </div>
  );
}

type LogSelection = { kind: "trace" | "pending"; id: string } | null;

function CalderynLog({
  pending,
  trace,
  selected,
  onSelectTrace,
  onSelectPending,
  onResolved,
}: {
  pending: PendingInspectorVM[];
  trace: TraceEventVM[];
  selected: LogSelection;
  onSelectTrace: (id: string) => void;
  onSelectPending: (alertId: string) => void;
  onResolved: (alertId: string) => void;
}) {
  return (
    <div className="engx-trace">
      <div className="engx-trace-head">
        <div className="engx-trace-title">
          <span className="engx-live-dot" />
          <h2>Calderyn log</h2>
        </div>
        <p className="engx-trace-sub">Newest first. Click any row to see why.</p>
      </div>
      {pending.length === 0 && trace.length === 0 ? (
        <div className="engx-trace-empty">
          Nothing yet. When Calderyn acts on its own, or you approve a suggestion, it shows up here with the full reasoning.
        </div>
      ) : (
        <div className="engx-trace-list">
          {pending.map((p) => (
            <PendingRow
              key={p.alertId}
              p={p}
              selected={selected?.kind === "pending" && selected.id === p.alertId}
              onSelect={() => onSelectPending(p.alertId)}
              onResolved={onResolved}
            />
          ))}
          {trace.map((t) => (
            <TraceRow
              key={t.id}
              t={t}
              selected={selected?.kind === "trace" && selected.id === t.id}
              onSelect={() => onSelectTrace(t.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- 2b. inspector ---------- */
function Inspector({ t, onClose }: { t: TraceEventVM; onClose: () => void }) {
  const pill = moneyPill(t);
  return (
    <div className="engx-insp">
      <div className="engx-insp-head">
        <button type="button" className="engx-insp-back" aria-label="Close" onClick={onClose}>
          <IChevL />
        </button>
        <span className="engx-insp-tag" data-tag={t.tag}>
          {TAG_LABEL[t.tag]}
        </span>
        <span className="engx-insp-time">{t.time}</span>
      </div>
      <div className="engx-insp-body">
        <h3 className="engx-insp-title">{t.title}</h3>

        {pill && (
          <div className={`engx-insp-money engx-insp-money--${pill.tone}`}>
            <span>{t.tag === "AUTO" ? "Ad spend protected" : t.tag === "UNDONE" ? "Reversed" : "Impact"}</span>
            <strong>{fmtMoney(Math.abs(t.moneyCents))}</strong>
          </div>
        )}

        <div className="engx-insp-sec">
          <div className="engx-insp-sec-h">WHAT IT SAW</div>
          <p className="engx-insp-signal">{t.signal}</p>
          {t.evidence.length > 0 && (
            <div className="engx-insp-ev">
              {t.evidence.map((e, n) => (
                <div className="engx-insp-ev-row" key={n}>
                  <span className="engx-insp-ev-dot" />
                  <span>{e}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {t.factors && t.confidence != null && (
          <div className="engx-insp-sec">
            <div className="engx-insp-sec-h">HOW IT WEIGHED THIS</div>
            <div className="engx-insp-factors">
              {t.factors.map((fac) => (
                <div className="engx-insp-factor" key={fac.key}>
                  <div className="engx-insp-factor-top">
                    <span>{fac.label}</span>
                    <span className="engx-insp-factor-val">{fac.value}%</span>
                  </div>
                  <span className="engx-insp-factor-bar">
                    <span className="engx-insp-factor-fill" style={{ width: `${fac.value}%` }} />
                  </span>
                </div>
              ))}
            </div>
            <div className="engx-insp-conf" data-auto={t.confidence >= t.threshold}>
              <div className="engx-insp-conf-pct">{t.confidence}%</div>
              <div className="engx-insp-conf-note">
                Auto-act bar is {t.threshold}%.{" "}
                {t.confidence >= t.threshold
                  ? "This pair clears it, so Calderyn can run it on its own."
                  : "Below the bar, so Calderyn brings it to you until its track record grows."}
              </div>
            </div>
          </div>
        )}

        <div className="engx-insp-sec">
          <div className="engx-insp-sec-h">DECISION</div>
          <span className="engx-insp-dec-label" data-tag={t.tag}>
            {t.decisionLabel}
          </span>
          <p className="engx-insp-dec-note">{t.decisionNote}</p>
        </div>

        <a className="engx-insp-cta" href="/app/audit">
          View in action history
          <IChevR s={15} />
        </a>
      </div>
    </div>
  );
}

/* ---------- 2c. pending inspector (NEEDS YOU) ---------- */
// The simplified card: why Calderyn flagged it + a few humanized figures, then
// what approving vs. denying does and one plain line on why it asks. No weighing
// bars; the approve/deny buttons live on the log row.
function PendingInspector({ p, onClose }: { p: PendingInspectorVM; onClose: () => void }) {
  return (
    <div className="engx-insp">
      <div className="engx-insp-head">
        <button type="button" className="engx-insp-back" aria-label="Close" onClick={onClose}>
          <IChevL />
        </button>
        <span className="engx-insp-tag" data-tag="REVIEW">
          NEEDS YOU
        </span>
        <span className="engx-insp-time">now</span>
      </div>
      <div className="engx-insp-body">
        <h3 className="engx-insp-title">{p.title}</h3>

        {p.dollarImpactCents !== 0 && (
          <div className="engx-insp-money engx-insp-money--good">
            <span>At stake</span>
            <strong>{fmtMoney(Math.abs(p.dollarImpactCents))}</strong>
          </div>
        )}

        <div className="engx-insp-sec">
          <div className="engx-insp-sec-h">WHY CALDERYN FLAGGED THIS</div>
          <p className="engx-insp-signal">{p.signal}</p>
          {p.stats.length > 0 && (
            <div className="engx-insp-stats">
              {p.stats.map((s) => (
                <div className="engx-insp-stat" key={s.label}>
                  <span className="engx-insp-stat-lab">{s.label}</span>
                  <span className="engx-insp-stat-val">{s.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="engx-insp-sec engx-insp-decide">
          <div>
            <div className="engx-insp-sec-h">IF YOU APPROVE</div>
            <p className="engx-insp-act-note">{p.approveText}</p>
          </div>
          <div>
            <div className="engx-insp-sec-h">IF YOU DENY</div>
            <p className="engx-insp-act-note">{p.denyText}</p>
          </div>
          <p className="engx-insp-trust">{p.trustLine}</p>
        </div>
      </div>
    </div>
  );
}

/* ---------- view ---------- */
function Stack({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>{children}</div>;
}

/**
 * The full Live Engine surface for the embedded app, mirroring the web
 * dashboard's Overview: the shared AutopilotHero (Watching / Acting, calibration
 * and money), the Calderyn log + inspector, and the grouped autopilot-features
 * rail. Stateless apart from the local selection + freshness ticker. The feature
 * toggle posts to the route that mounts it (no action url), so each host wires
 * its own action.
 */
export default function LiveEngineView({ data }: { data: LiveEnginePageData }) {
  const [selected, setSelected] = useState<LogSelection>(null);
  // Proposals worked through this session, hidden immediately so the row leaves
  // before the next revalidation swaps in fresh loader data.
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const revalidator = useRevalidator();

  const livePending = data.pending.filter((p) => !resolved.has(p.alertId));

  // Gentle freshness: pull new actions/money while the tab is visible and the
  // merchant isn't mid-inspection. Real new rows, not fabricated motion.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible" && !selected && revalidator.state === "idle") {
        revalidator.revalidate();
      }
    };
    const id = setInterval(tick, 45000);
    return () => clearInterval(id);
  }, [selected, revalidator]);

  const markResolved = useCallback(
    (alertId: string) => {
      setResolved((s) => new Set(s).add(alertId));
      setSelected((cur) => (cur?.kind === "pending" && cur.id === alertId ? null : cur));
      revalidator.revalidate();
    },
    [revalidator],
  );

  const selectedTrace =
    selected?.kind === "trace" ? data.trace.find((t) => t.id === selected.id) ?? null : null;
  const selectedPending =
    selected?.kind === "pending" ? livePending.find((p) => p.alertId === selected.id) ?? null : null;

  // Hero inputs, computed from the same data contract the dashboard hero uses.
  const featureOn = data.autopilotEnabled ? data.features.filter((f) => f.enabled).length : 0;
  const featureTotal = data.features.length;
  const band = calibrationBand(data.calibrationPct);
  const running = data.autopilotEnabled && featureOn > 0;
  // Flag the Watching rows whose domain has a proposal awaiting approval, so the
  // hero reads the live queue the same way the dashboard does.
  const flagged = new Set<WatchGroup>(livePending.map((p) => domainForDetector(p.detectorId)));

  return (
    <Stack>
      <AutopilotHero
        running={running}
        featureOn={featureOn}
        featureTotal={featureTotal}
        calibrationPct={data.calibrationPct}
        level={band.level}
        levels={band.levels}
        moneyProtectedCents={data.moneyProtectedWeekCents}
        flaggedGroups={flagged}
        watchScan={data.watchScan}
      />
      <div className="engx-cols">
        <CalderynLog
          pending={livePending}
          trace={data.trace}
          selected={selected}
          onSelectTrace={(id) => setSelected({ kind: "trace", id })}
          onSelectPending={(id) => setSelected({ kind: "pending", id })}
          onResolved={markResolved}
        />
        <div className="engx-rail">
          {selectedPending ? (
            <PendingInspector p={selectedPending} onClose={() => setSelected(null)} />
          ) : selectedTrace ? (
            <Inspector t={selectedTrace} onClose={() => setSelected(null)} />
          ) : (
            <AutopilotFeaturesCard data={data} />
          )}
        </div>
      </div>
    </Stack>
  );
}

export { LiveBadge };
