import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useEffect, useState, type ReactNode } from "react";
import { Page, Text } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { calderynClient } from "~/lib/calderyn.server";
import { fmtMoney } from "~/lib/format";
import { calibrationBand } from "~/lib/calibration/bands";
import { buildLiveEnginePageData } from "~/lib/calibration/live-engine-page.server";
import type {
  LiveEnginePageData,
  LiveEngineFeatureVM,
  PipelineCallVM,
  PredictionVM,
  TraceEventVM,
  TraceTag,
} from "~/lib/calibration/live-engine-page.server";
import type { ActionKind } from "~/lib/types";

/* ---------- inline icons (stroke=currentColor so CSS color drives the tint) ---------- */
const sx = { display: "block" } as const;
type IP = { s?: number; w?: number };
function ILock({ s = 22, w = 2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} style={sx}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>);
}
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
function IAlert({ s = 14, w = 2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} style={sx}><path d="M12 9v4M12 16.5h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>);
}
function IList({ s = 14, w = 2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} style={sx}><path d="M5 12h14M5 7h14M5 17h9" /></svg>);
}
function IEye({ s = 15, w = 2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} style={sx}><circle cx="12" cy="12" r="3" /><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /></svg>);
}
function IChevR({ s = 16, w = 2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} style={sx}><path d="M9 6l6 6-6 6" /></svg>);
}
function IChevL({ s = 15, w = 2.2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} style={sx}><path d="M15 6l-6 6 6 6" /></svg>);
}
function IBox({ s = 14, w = 2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} style={sx}><path d="M3 8l9-5 9 5v8l-9 5-9-5V8Z" /><path d="M3 8l9 5 9-5M12 13v8" /></svg>);
}
function IDown({ s = 14, w = 2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} style={sx}><path d="M5 8l5 5 3-3 6 7" /><path d="M16 17h4v-4" /></svg>);
}
function IRadar({ s = 17, w = 1.9 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} style={sx}><path d="M3 12a9 9 0 0 1 18 0" /><path d="M12 12l4-2.5" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /></svg>);
}
function IScore({ s = 14, w = 2 }: IP) {
  return (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} style={sx}><path d="M5 19a7 7 0 1 1 14 0" /><path d="M12 19l3.5-4.5" strokeLinecap="round" /></svg>);
}

/* ---------- loader ---------- */
type LoaderPayload = LiveEnginePageData;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  const data = await buildLiveEnginePageData(client, request.signal);
  return json<LoaderPayload>(data);
};

/* ---------- action (per-feature autonomy toggle) ---------- */
type ActionPayload = { ok: true; enabled: boolean } | { error: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "toggle-feature") {
    const detectorId = String(formData.get("detectorId") ?? "").trim();
    const actionKind = String(formData.get("actionKind") ?? "").trim() as ActionKind;
    const enabled = String(formData.get("enabled") ?? "") === "true";
    if (!detectorId || !actionKind) {
      return json<ActionPayload>({ error: "Missing feature" }, { status: 400 });
    }
    const r = await client.calibration.setFeatureAutonomy(detectorId, actionKind, enabled);
    if (!r.ok) return json<ActionPayload>({ error: "Could not update this feature" }, { status: 500 });
    return json<ActionPayload>({ ok: true, enabled });
  }

  return json<ActionPayload>({ error: "Unknown intent" }, { status: 400 });
};

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

/* ---------- 1. autopilot features ---------- */
function FeatureRow({ f, autopilotEnabled }: { f: LiveEngineFeatureVM; autopilotEnabled: boolean }) {
  const fetcher = useFetcher<ActionPayload>();
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
          {active && (
            <span className="engx-feat-active">
              <span className="engx-live-dot engx-live-dot--sm" />
              ACTIVE
            </span>
          )}
        </div>
        <div className="engx-feat-sub">
          {f.watching} &middot; {f.lastText}
        </div>
        {!f.proven && (
          <Text as="p" variant="bodySm" tone="subdued">
            Approved {f.approvals}/{f.approvalsNeeded} &middot; made money {f.outcomes}/{f.outcomesNeeded}. A few more good results and it can run on its own.
          </Text>
        )}
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

function AutopilotCard({ data }: { data: LiveEnginePageData }) {
  // "Unlocked" = how many features are available (graduated / shipped). That is
  // stable; turning an individual feature off must not change it. "Live" counts
  // the ones actually running, which only happens with shop-level autopilot on.
  const unlocked = data.features.length;
  const live = data.autopilotEnabled ? data.features.filter((f) => f.enabled).length : 0;
  const running = live > 0;
  return (
    <div className="engx-auto">
      <div className="engx-auto-head">
        <span className="engx-auto-ico">
          <ILock />
        </span>
        <div className="engx-auto-titles">
          <div className="engx-auto-h2row">
            <h2 className="engx-auto-h2">{running ? "Autopilot is running" : "Autopilot"}</h2>
            {running ? (
              <span className="engx-auto-badge">
                <span className="engx-live-dot engx-live-dot--sm" />
                {live} {live === 1 ? "feature live" : "features live"}
              </span>
            ) : (
              <span className="engx-auto-badge engx-auto-badge--off">
                {unlocked > 0 ? `${unlocked} ${unlocked === 1 ? "feature unlocked" : "features unlocked"}` : "No features yet"}
              </span>
            )}
          </div>
          <p className="engx-auto-sub">
            {running
              ? "These graduated to run without you. Calderyn handles them on its own and logs every action below."
              : unlocked > 0
                ? "These no-brainer features ship unlocked. Turn on shop-level Autopilot in Settings when you want Calderyn to run them."
                : "Approve suggestions in the Action Queue to graduate your most-trusted fixes to run here on their own."}
          </p>
        </div>
        {running && (
          <div className="engx-auto-money">
            <div className="engx-auto-money-amt">{fmtMoney(data.moneyProtectedWeekCents)}</div>
            <div className="engx-auto-money-cap">protected this week</div>
          </div>
        )}
      </div>
      {data.features.length === 0 ? (
        <div className="engx-auto-empty">
          No features run on autopilot yet. As you approve suggestions in the{" "}
          <a href="/app/queue">Action Queue</a>, the ones you trust most graduate to run here on their own.
        </div>
      ) : (
        <div className="engx-feat-list">
          {data.features.map((f) => (
            <FeatureRow
              key={`${f.detectorId}:${f.actionKind}`}
              f={f}
              autopilotEnabled={data.autopilotEnabled}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- 2. engine pipeline ---------- */
function PipelineGraph({ call }: { call: PipelineCallVM }) {
  return (
    <div className="engx-graph">
      <div className="engx-node engx-node--trigger">
        <div className="engx-node-head">
          <span className="engx-node-tag-ico">
            <IAlert />
          </span>
          <span className="engx-node-tag">SPOTTED</span>
        </div>
        <div className="engx-node-title">{call.title}</div>
        <div className="engx-node-ctx">{call.context}</div>
      </div>

      <span className="engx-arrow" aria-hidden>
        <IChevR s={18} />
      </span>

      <div className="engx-node engx-node--checks">
        <div className="engx-node-head">
          <span className="engx-node-tag-ico">
            <IList />
          </span>
          <span className="engx-node-tag">CHECKS 3 THINGS</span>
        </div>
        <div className="engx-factors">
          {call.factors.map((fac) => (
            <div className="engx-factor" key={fac.key}>
              <span className="engx-factor-lab">{fac.label}</span>
              <span className="engx-factor-bar">
                <span className="engx-factor-fill" style={{ width: `${fac.value}%` }} />
              </span>
            </div>
          ))}
        </div>
      </div>

      <span className="engx-arrow" aria-hidden>
        <IChevR s={18} />
      </span>

      <div className="engx-node engx-node--gate">
        <div className="engx-gate-lab">SURE ENOUGH?</div>
        <div className="engx-gate-pct" data-auto={call.auto}>
          {call.confidence}%
        </div>
        <div className="engx-gate-need">needs {call.threshold}%</div>
      </div>

      <div className="engx-outs">
        <div className="engx-out engx-out--auto" data-lit={call.auto}>
          <span className="engx-out-ico">
            <ICheck />
          </span>
          <div>
            <div className="engx-out-t">Handle it</div>
            <div className="engx-out-s">on its own</div>
          </div>
        </div>
        <div className="engx-out engx-out--ask" data-lit={!call.auto}>
          <span className="engx-out-ico">
            <IList />
          </span>
          <div>
            <div className="engx-out-t">Ask you first</div>
            <div className="engx-out-s">you decide</div>
          </div>
        </div>
      </div>
    </div>
  );
}

const STEPS: { name: string; desc: string; icon: ReactNode }[] = [
  { name: "Watch", desc: "Reads your ad spend, inventory and orders", icon: <IEye /> },
  { name: "Detect", desc: "Finds money leaks across its built-in checks", icon: <IAlert /> },
  { name: "Score", desc: "Weighs how much it trusts each fix", icon: <IScore /> },
  { name: "Decide", desc: "Acts on its own or asks you first", icon: <IList /> },
];

function PipelineCard({ pipeline }: { pipeline: PipelineCallVM[] }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (pipeline.length < 2) return;
    const t = setInterval(() => setI((n) => (n + 1) % pipeline.length), 4200);
    return () => clearInterval(t);
  }, [pipeline.length]);

  const idx = pipeline.length ? i % pipeline.length : 0;

  return (
    <div className="engx-pipe">
      <div className="engx-pipe-head">
        <div>
          <h2 className="engx-pipe-h2">Watch Calderyn work</h2>
          <p className="engx-pipe-sub">
            {pipeline.length
              ? "A real call moving through the engine, from what it spotted to what it decided."
              : "The path every call takes through the engine."}
          </p>
        </div>
        {pipeline.length > 0 && (
          <span className="engx-pipe-run">
            <span className="engx-live-dot" />
            Running now
          </span>
        )}
      </div>

      {pipeline.length ? (
        <>
          <PipelineGraph call={pipeline[idx]} />
          {pipeline.length > 1 && (
            <div className="engx-dots">
              {pipeline.map((_, n) => (
                <span key={n} className="engx-dot" data-on={n === idx} />
              ))}
              <span className="engx-dots-cap">updates live</span>
            </div>
          )}
        </>
      ) : (
        <div className="engx-pipe-steps">
          {STEPS.map((s, n) => (
            <div className="engx-step" key={s.name}>
              <span className="engx-step-ico">{s.icon}</span>
              <div className="engx-step-name">
                {n + 1}. {s.name}
              </div>
              <div className="engx-step-desc">{s.desc}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- 3a. trace ---------- */
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

function TraceCard({ trace, selectedId, onSelect }: { trace: TraceEventVM[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="engx-trace">
      <div className="engx-trace-head">
        <div className="engx-trace-title">
          <span className="engx-live-dot" />
          <h2>What Calderyn just did</h2>
        </div>
        <p className="engx-trace-sub">Newest first. Click any row to see why.</p>
      </div>
      {trace.length === 0 ? (
        <div className="engx-trace-empty">
          Nothing yet. When Calderyn acts on its own, or you approve a suggestion, it shows up here with the full reasoning.
        </div>
      ) : (
        <div className="engx-trace-list">
          {trace.map((t) => (
            <TraceRow key={t.id} t={t} selected={t.id === selectedId} onSelect={() => onSelect(t.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- 3b. inspector ---------- */
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

/* ---------- 3c. default rail: calibration mini + predictions ---------- */
function CalibrationMini({ pct }: { pct: number | null }) {
  const band = calibrationBand(pct);
  const shown = Math.max(0, Math.min(100, Math.round(pct ?? 0)));
  const R = 26;
  const C = 2 * Math.PI * R;
  const offset = C * (1 - shown / 100);
  return (
    <div className="engx-cal">
      <a className="engx-cal-top" href="/app/queue">
        <div className="engx-cal-ring">
          <svg width="62" height="62" viewBox="0 0 62 62">
            <circle cx="31" cy="31" r={R} fill="none" stroke="#eef0f2" strokeWidth="6.5" />
            <circle className="engx-cal-ring-fill" cx="31" cy="31" r={R} fill="none" stroke="#23556e" strokeWidth="6.5" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={offset} />
          </svg>
          <span className="engx-cal-ring-pct">
            {shown}
            <span>%</span>
          </span>
        </div>
        <div className="engx-cal-body">
          <div className="engx-cal-namerow">
            <span className="engx-cal-name">Calibration</span>
            <span className="engx-cal-level">
              Level {band.level} of {band.levels}
            </span>
          </div>
          <p className="engx-cal-copy">More trust means more features graduate to autopilot.</p>
        </div>
      </a>
      <div className="engx-cal-track">
        {band.milestones.map((m) => (
          <span key={m.label} className="engx-cal-seg" data-reached={m.reached} />
        ))}
      </div>
      <div className="engx-cal-labels">
        {band.milestones.map((m) => (
          <span key={m.label} data-reached={m.reached}>
            {m.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function predIcon(p: PredictionVM): ReactNode {
  if (p.kind === "stockout") return <IBox />;
  if (p.tone === "up") return <IUp />;
  return <IDown />;
}

function Predictions({ predictions }: { predictions: PredictionVM[] }) {
  return (
    <div className="engx-pred">
      <div className="engx-pred-head">
        <div className="engx-pred-h2row">
          <span className="engx-pred-h2ico">
            <IRadar />
          </span>
          <h2 className="engx-pred-h2">What Calderyn sees coming</h2>
        </div>
        <p className="engx-pred-sub">Forecasts from the same signals, before they become problems.</p>
      </div>
      {predictions.length === 0 ? (
        <div className="engx-pred-empty">
          Nothing flagged as coming up. Calderyn will surface inventory running low and campaigns slipping below breakeven here as it spots them.
        </div>
      ) : (
        <div className="engx-pred-list">
          {predictions.map((p, n) => (
            <div className="engx-pred-row" key={n} data-tone={p.tone}>
              <span className="engx-pred-ico">{predIcon(p)}</span>
              <div className="engx-pred-main">
                <div className="engx-pred-text">{p.text}</div>
                <div className="engx-pred-detail">{p.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- screen ---------- */
function Stack({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>{children}</div>;
}

export default function LiveEngine() {
  const data = useLoaderData<typeof loader>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const revalidator = useRevalidator();

  // Gentle freshness: pull new actions/money while the tab is visible and the
  // merchant isn't mid-inspection. Real new rows, not fabricated motion.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible" && !selectedId && revalidator.state === "idle") {
        revalidator.revalidate();
      }
    };
    const id = setInterval(tick, 45000);
    return () => clearInterval(id);
  }, [selectedId, revalidator]);

  const selected = selectedId ? data.trace.find((t) => t.id === selectedId) ?? null : null;

  return (
    <Page
      title="Live Engine"
      subtitle="Your autopilot features running on their own. What they are doing, and why."
      titleMetadata={<LiveBadge />}
    >
      <Stack>
        <AutopilotCard data={data} />
        <PipelineCard pipeline={data.pipeline} />
        <div className="engx-cols">
          <TraceCard trace={data.trace} selectedId={selectedId} onSelect={setSelectedId} />
          <div className="engx-rail">
            {selected ? (
              <Inspector t={selected} onClose={() => setSelectedId(null)} />
            ) : (
              <>
                <CalibrationMini pct={data.calibrationPct} />
                <Predictions predictions={data.predictions} />
              </>
            )}
          </div>
        </div>
      </Stack>
    </Page>
  );
}
