import { useLoaderData, useFetcher } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useEffect, useState, type ReactNode } from "react";
import { Banner, Page } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { calderynClient, type CalderynError } from "~/lib/calderyn.server";
import { newIdempotencyKey } from "~/lib/ids";
import { fmtMoney } from "~/lib/format";
import { alertDetectorLabel, ACTION_LABELS, recommendedAction } from "~/lib/labels";
import CalibrationLevelHeader from "~/components/calderyn/CalibrationLevelHeader";
import { MIN_APPROVALS } from "~/lib/calibration/graduation";
import { actionTier } from "~/lib/calibration/confidence";
import type { ApproveReceipt } from "~/lib/calibration/delta";
import type { ActionKind, LearnedRule, QueueProposal, RejectReason } from "~/lib/types";

// The 5 valid reject reasons (mirrors types.ts RejectReason union).
const REJECT_REASONS: RejectReason[] = [
  "too_aggressive",
  "wrong_timing",
  "not_enough_data",
  "i_handle_this",
  "other",
];

const REJECT_REASON_LABELS: Record<RejectReason, string> = {
  too_aggressive: "Too aggressive",
  wrong_timing: "Wrong timing",
  not_enough_data: "Not enough data yet",
  i_handle_this: "I handle this myself",
  other: "Other",
};

// Plain-language "so Calderyn will now ___" line for the reflection receipt.
// No em dashes (founder treats them as an AI tell).
const LEARNED_TEXT: Record<RejectReason, string> = {
  too_aggressive: "keep this kind of fix smaller than what it just proposed.",
  wrong_timing: "weigh the timing before it suggests this again.",
  not_enough_data: "wait for stronger proof before it acts on this.",
  i_handle_this: "leave this kind of call to you from now on.",
  other: "take your note into account next time.",
};

function confidenceBand(pct: number): "high" | "med" | "low" {
  if (pct >= 75) return "high";
  if (pct >= 45) return "med";
  return "low";
}

/* ---------- inline icons (stroked, matching the design) ---------- */
const sx = { display: "block" } as const;
function ICheck({ s = 15, w = 2.4 }: { s?: number; w?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} style={sx}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
function IX({ s = 16, w = 2.2 }: { s?: number; w?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} style={sx}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
function IBolt() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" style={sx}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
    </svg>
  );
}
function IInfo() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={sx}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16h.01" />
    </svg>
  );
}
function IHex() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff" style={sx}>
      <path d="M12 2.5 20 7v10l-8 4.5L4 17V7l8-4.5Z" />
      <path d="M12 6 16.5 8.6v5.2L12 16.4 7.5 13.8V8.6L12 6Z" fill="#23556e" />
    </svg>
  );
}
function IGauge() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={sx}>
      <path d="M5 19a7 7 0 1 1 14 0" />
      <path d="M12 19l3.5-4.5" strokeLinecap="round" />
    </svg>
  );
}
function IDid() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={sx}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.2l2.4 2.4 4.6-5" />
    </svg>
  );
}
function ISave() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" style={sx}>
      <path d="M12 5v14M6 13l6 6 6-6" />
    </svg>
  );
}
function IUndo() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={sx}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
    </svg>
  );
}
function IShield() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" style={sx}>
      <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z" />
    </svg>
  );
}

/* ---------- loader ---------- */
type LoaderPayload = {
  proposals: QueueProposal[];
  learnedRules: LearnedRule[];
  calibrationPct: number | null;
  nearGraduation: number;
  error: { code: string; message: string } | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  try {
    const [proposalsResult, rulesResult, calResult, nearResult] = await Promise.allSettled([
      client.queue.list(request.signal),
      client.calibration.learnedRules(),
      client.calibration.get(request.signal),
      client.calibration.nearGraduation(),
    ]);

    const proposals = proposalsResult.status === "fulfilled" ? proposalsResult.value : [];
    const learnedRules = rulesResult.status === "fulfilled" ? rulesResult.value : [];
    const calibrationPct = calResult.status === "fulfilled" ? calResult.value.pct : null;
    const nearGraduation = nearResult.status === "fulfilled" ? nearResult.value : 0;

    if (proposalsResult.status === "rejected") {
      const e = proposalsResult.reason as CalderynError;
      return json<LoaderPayload>({
        proposals: [],
        learnedRules,
        calibrationPct,
        nearGraduation,
        error: { code: e.code ?? "ERROR", message: e.message },
      });
    }

    return json<LoaderPayload>({ proposals, learnedRules, calibrationPct, nearGraduation, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      proposals: [],
      learnedRules: [],
      calibrationPct: null,
      nearGraduation: 0,
      error: { code: e.code ?? "ERROR", message: e.message },
    });
  }
};

/* ---------- action (reject + undo-rule; approve posts to /app/alerts/$id) ---------- */
type RejectResult = {
  reflection: string;
  delta: number;
  before: number;
  after: number;
  savedAsRule: boolean;
};
type ActionPayload = RejectResult | { ok: true } | { error: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "reject") {
    const alertId = String(formData.get("alertId") ?? "").trim();
    const reason = String(formData.get("reason") ?? "").trim() as RejectReason;
    const note = String(formData.get("note") ?? "").trim() || undefined;

    if (!alertId) {
      return json<ActionPayload>({ error: "Missing alertId" }, { status: 400 });
    }
    if (!REJECT_REASONS.includes(reason)) {
      return json<ActionPayload>({ error: "Invalid reason" }, { status: 400 });
    }

    // Re-derive detector/action/impact from the TRUSTED alert — never the form.
    const alert = await client.alerts.get(alertId);
    const detectorId = alert.detector_id;
    const hasCampaign = Boolean(alert.campaign_id);
    const actionKind = recommendedAction(detectorId, { hasCampaign });
    if (!actionKind) {
      return json<ActionPayload>({ error: "No recommended action for this alert" }, { status: 400 });
    }

    // Records the rejection signal; executes NOTHING.
    const r = await client.calibration.recordRejection({
      alertId,
      detectorId,
      actionKind,
      reason,
      note,
      dollarImpactCents: alert.dollar_impact,
    });

    return json<ActionPayload>({
      reflection: r.reflection,
      delta: r.delta,
      before: r.before,
      after: r.after,
      savedAsRule: r.savedAsRule,
    });
  }

  if (intent === "undo-rule") {
    const ruleId = String(formData.get("ruleId") ?? "").trim();
    if (!ruleId) {
      return json<ActionPayload>({ error: "Missing ruleId" }, { status: 400 });
    }
    await client.calibration.undoRule(ruleId);
    return json<ActionPayload>({ ok: true });
  }

  return json<ActionPayload>({ error: "Unknown intent" }, { status: 400 });
};

/* ---------- reflection receipt (post-reject) ---------- */
function ReflectionReceipt({ data, reason }: { data: RejectResult; reason: RejectReason }) {
  const delta = data.delta;
  const deltaTone = delta < 0 ? "down" : delta > 0 ? "up" : "flat";
  const deltaLabel = delta === 0 ? "no change" : delta > 0 ? `+${delta}%` : `${delta}%`;
  return (
    <div className="aqx-receipt">
      <div className="aqx-voice">
        <span className="aqx-voice-ico">
          <IHex />
        </span>
        <div className="aqx-voice-body">
          <div className="aqx-voice-eyebrow">Calderyn learned something</div>
          <p className="aqx-voice-text">{data.reflection}</p>
        </div>
      </div>
      <div className="aqx-learned">
        <div className="aqx-learned-head">WHAT CALDERYN LEARNED FROM THIS</div>
        <div className="aqx-learned-row">
          <span className="aqx-learned-ico aqx-learned-ico--reason">
            <IX s={15} w={2.2} />
          </span>
          <div className="aqx-learned-main">
            <div className="aqx-learned-title">You rejected this because</div>
            <div className="aqx-learned-sub">&ldquo;{REJECT_REASON_LABELS[reason]}&rdquo;</div>
          </div>
        </div>
        <div className="aqx-learned-row">
          <span className="aqx-learned-ico aqx-learned-ico--did">
            <IDid />
          </span>
          <div className="aqx-learned-main">
            <div className="aqx-learned-title">
              So Calderyn will now
              {data.savedAsRule && (
                <span className="aqx-saved">
                  saved as a rule
                  <ISave />
                </span>
              )}
            </div>
            <div className="aqx-learned-sub">{LEARNED_TEXT[reason]}</div>
          </div>
        </div>
        <div className="aqx-learned-row aqx-learned-row--trust">
          <span className="aqx-learned-ico aqx-learned-ico--trust">
            <IGauge />
          </span>
          <div className="aqx-learned-main">
            <div className="aqx-learned-title">Trust in this fix</div>
            <div className="aqx-learned-sub">Calderyn is now about {data.after}% sure here.</div>
          </div>
          <span className={`aqx-delta aqx-delta--${deltaTone}`}>{deltaLabel}</span>
        </div>
      </div>
    </div>
  );
}

/* ---------- graduation moment (celebratory, screen-level) ---------- */
type GraduatedInfo = { detectorId: string; actionKind: ActionKind; label: string };

function GraduationMoment({ info, onDismiss }: { info: GraduatedInfo; onDismiss: () => void }) {
  const toggleFetcher = useFetcher<{ ok?: boolean; enabled?: boolean } | { error: string }>();
  const [on, setOn] = useState(false);
  const min = MIN_APPROVALS[actionTier(info.actionKind)];

  // Reconcile to the server's echo: success returns { enabled }, error doesn't.
  useEffect(() => {
    if (toggleFetcher.state !== "idle" || !toggleFetcher.data) return;
    const d = toggleFetcher.data as { enabled?: boolean };
    setOn(Boolean(d.enabled));
  }, [toggleFetcher.state, toggleFetcher.data]);

  const toggle = () => {
    const next = !on;
    setOn(next); // optimistic
    toggleFetcher.submit(
      { intent: "toggle-feature", detectorId: info.detectorId, actionKind: info.actionKind, enabled: String(next) },
      { method: "post", action: "/app/engine" },
    );
  };

  return (
    <div className="aqx-grad">
      <button type="button" className="aqx-grad-x" aria-label="Dismiss" onClick={onDismiss}>
        <IX s={15} w={2.2} />
      </button>
      <div className="aqx-grad-eyebrow">
        <IBolt /> Autopilot unlocked
      </div>
      <h3 className="aqx-grad-title">
        You can now let Calderyn <b>{info.label.toLowerCase()}</b> on autopilot
      </h3>
      <div className="aqx-grad-check">
        <ICheck s={13} w={2.8} /> Approved {min} times in a row
      </div>
      <div className="aqx-grad-actions">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`${on ? "Turn off" : "Turn on"} autopilot for this fix`}
          className="aqx-grad-toggle"
          data-on={on}
          disabled={toggleFetcher.state !== "idle"}
          onClick={toggle}
        >
          <span className="aqx-grad-toggle-knob" />
        </button>
        <span className="aqx-grad-toggle-lab">{on ? "Autopilot is on for this fix" : "Turn on autopilot"}</span>
      </div>
      <div className="aqx-grad-foot">
        You stay in control. Manage every autopilot fix from the <a href="/app/engine">Live Engine</a>.
      </div>
    </div>
  );
}

/* ---------- approve receipt (post-approve) ---------- */
function ApproveReceiptPanel({
  receipt,
  actionKind,
  actionLabel,
}: {
  receipt: ApproveReceipt;
  actionKind: ActionKind;
  actionLabel: string;
}) {
  const delta = receipt.delta;
  const deltaTone = delta < 0 ? "down" : delta > 0 ? "up" : "flat";
  const deltaLabel = delta === 0 ? "no change" : delta > 0 ? `+${delta}%` : `${delta}%`;
  const min = MIN_APPROVALS[actionTier(actionKind)];
  const remaining = Math.max(0, min - receipt.cleanApprovals);
  const showProgress = receipt.graduatable && !receipt.justGraduated;
  const cleanPct = Math.min(100, Math.round((receipt.cleanApprovals / Math.max(1, min)) * 100));

  return (
    <div className="aqx-receipt">
      <div className="aqx-voice">
        <span className="aqx-voice-ico">
          <IHex />
        </span>
        <div className="aqx-voice-body">
          <div className="aqx-voice-eyebrow">Calderyn learned something</div>
          <p className="aqx-voice-text">
            Approved. Calderyn is now about {receipt.after}% sure about this fix and will lean toward doing it for you.
          </p>
        </div>
      </div>
      <div className="aqx-learned">
        <div className="aqx-learned-row aqx-learned-row--trust">
          <span className="aqx-learned-ico aqx-learned-ico--did">
            <ICheck />
          </span>
          <div className="aqx-learned-main">
            <div className="aqx-learned-title">Trust in this fix</div>
            <div className="aqx-learned-sub">You taught Calderyn to {actionLabel.toLowerCase()} here.</div>
          </div>
          <span className={`aqx-delta aqx-delta--${deltaTone}`}>{deltaLabel}</span>
        </div>
        {showProgress && (
          <div className="aqx-grad-prog">
            <div className="aqx-grad-prog-top">
              <span>Toward autopilot</span>
              <span>
                {receipt.cleanApprovals} of {min}
              </span>
            </div>
            <div className="aqx-grad-prog-bar">
              <div className="aqx-grad-prog-fill" style={{ width: `${cleanPct}%` }} />
            </div>
            <div className="aqx-grad-prog-cap">
              {remaining === 0
                ? "Ready to graduate on its next clean approval."
                : `Approve this fix ${remaining} more time${remaining === 1 ? "" : "s"} in a row to let Calderyn run it on autopilot.`}
            </div>
          </div>
        )}
        {receipt.justGraduated && (
          <div className="aqx-grad-inline">
            <IBolt /> Autopilot unlocked for this fix. Turn it on at the top of the queue.
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- one proposal card ---------- */
type CardView = "idle" | "confirm" | "reject" | "approved" | "rejected";

function ProposalCard({ p, onGraduated }: { p: QueueProposal; onGraduated: (info: GraduatedInfo) => void }) {
  const [view, setView] = useState<CardView>("idle");
  const [reason, setReason] = useState<RejectReason | null>(null);
  const [note, setNote] = useState("");
  const [receipt, setReceipt] = useState<ApproveReceipt | null>(null);
  const [idemKey] = useState(() => newIdempotencyKey());

  const approveFetcher = useFetcher<{ ok?: boolean; calibration?: ApproveReceipt; toast?: { message?: string; isError?: boolean } }>();
  const rejectFetcher = useFetcher<ActionPayload>();

  const detector = alertDetectorLabel(p.detector_id, {});
  const actionLabel = ACTION_LABELS[p.action_kind] ?? p.action_kind;
  const band = confidenceBand(p.confidence);

  const approving = approveFetcher.state !== "idle";
  const rejecting = rejectFetcher.state !== "idle";

  // Transition to the done state once a submission resolves; capture the approve
  // receipt and bubble a graduation up to the screen-level moment.
  useEffect(() => {
    if (approveFetcher.state === "idle" && approveFetcher.data?.ok) {
      setView("approved");
      const cal = approveFetcher.data.calibration;
      if (cal) {
        setReceipt(cal);
        if (cal.justGraduated) {
          onGraduated({ detectorId: p.detector_id, actionKind: p.action_kind, label: actionLabel });
        }
      }
    }
  }, [approveFetcher.state, approveFetcher.data, onGraduated, p.detector_id, p.action_kind, actionLabel]);
  useEffect(() => {
    if (rejectFetcher.state === "idle" && rejectFetcher.data && "reflection" in rejectFetcher.data) {
      setView("rejected");
    }
  }, [rejectFetcher.state, rejectFetcher.data]);

  const doApprove = () => {
    approveFetcher.submit(
      { kind: p.action_kind, alertId: p.alertId, idempotencyKey: idemKey },
      { method: "post", action: `/app/alerts/${p.alertId}` },
    );
  };
  const doReject = () => {
    if (!reason) return;
    rejectFetcher.submit(
      { intent: "reject", alertId: p.alertId, reason, ...(reason === "other" && note.trim() ? { note: note.trim() } : {}) },
      { method: "post" },
    );
  };

  return (
    <div className="aqx-card" data-conf={band}>
      <div className="aqx-row">
        <div className="aqx-rail" />
        <div className="aqx-main">
          <div className="aqx-grid">
            <span className="aqx-ico">
              <IBolt />
            </span>
            <div className="aqx-body">
              <div className="aqx-titlerow">
                <span className="aqx-detector">{detector}</span>
                <span className="aqx-conf">{p.confidence}% confident</span>
              </div>
              <div className="aqx-reason">{p.reasoning}</div>
              <div className="aqx-will">
                <span className="aqx-will-lab">Will</span>
                <span className="aqx-will-act">{actionLabel}</span>
              </div>
            </div>
            <div className="aqx-side">
              <div className="aqx-impact">
                <div className="aqx-impact-amt">{fmtMoney(p.dollar_impact)}</div>
                <div className="aqx-impact-cap">at stake</div>
              </div>

              {(view === "idle" || view === "reject") && (
                <div className="aqx-acts">
                  <button
                    type="button"
                    className="aqx-btn aqx-reject-ico"
                    aria-label="Reject"
                    onClick={() => setView(view === "reject" ? "idle" : "reject")}
                  >
                    <IX />
                  </button>
                  <button type="button" className="aqx-btn aqx-approve" onClick={() => setView("confirm")}>
                    <ICheck /> Approve
                  </button>
                </div>
              )}

              {view === "confirm" && (
                <div className="aqx-acts">
                  <button type="button" className="aqx-btn aqx-cancel" onClick={() => setView("idle")} disabled={approving}>
                    Cancel
                  </button>
                  <button type="button" className="aqx-btn aqx-yes" onClick={doApprove} disabled={approving}>
                    <ICheck /> {approving ? "Approving" : "Yes, approve"}
                  </button>
                </div>
              )}

              {view === "approved" && (
                <span className="aqx-chip-done aqx-chip-approved">
                  <ICheck s={13} w={2.6} /> Approved
                </span>
              )}
              {view === "rejected" && (
                <span className="aqx-chip-done aqx-chip-rejected">
                  <ICheck s={13} w={2.4} /> Rejected
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {view === "confirm" && (
        <div className="aqx-confirm">
          <IInfo />
          <span className="aqx-confirm-text">
            Approve this? Calderyn will <strong>{actionLabel.toLowerCase()}</strong> now and learn to do it for you.
            You can undo it from the Live Engine within 48 hours.
          </span>
        </div>
      )}

      {view === "reject" && (
        <div className="aqx-reject">
          <div className="aqx-reject-q">
            Why are you rejecting this? <span>It teaches Calderyn what not to do.</span>
          </div>
          <div className="aqx-chips">
            {REJECT_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                className="aqx-chip"
                data-on={reason === r ? "true" : "false"}
                onClick={() => setReason(r)}
              >
                {REJECT_REASON_LABELS[r]}
              </button>
            ))}
          </div>
          {reason === "other" && (
            <textarea
              className="aqx-note"
              rows={2}
              placeholder="In your own words, what was off? e.g. We're clearing this stock on purpose, leave it running."
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
          <button
            type="button"
            className="aqx-confirm-reject"
            disabled={!reason || rejecting}
            onClick={doReject}
          >
            {rejecting ? "Saving" : "Confirm reject"}
          </button>
        </div>
      )}

      {view === "approved" && receipt && (
        <ApproveReceiptPanel receipt={receipt} actionKind={p.action_kind} actionLabel={actionLabel} />
      )}

      {view === "rejected" && rejectFetcher.data && "reflection" in rejectFetcher.data && reason && (
        <ReflectionReceipt data={rejectFetcher.data} reason={reason} />
      )}
    </div>
  );
}

/* ---------- learned rules (v2) ---------- */
function LearnedRules({ rules }: { rules: LearnedRule[] }) {
  const undoFetcher = useFetcher();
  return (
    <div className="aqx-rules">
      <div className="aqx-rules-head">
        <h2>What Calderyn has learned</h2>
        <p>Rules picked up from your rejections. Undo any rule to let Calderyn reconsider it.</p>
      </div>
      {rules.length === 0 ? (
        <div className="aqx-rules-empty">
          Nothing learned yet. As you reject suggestions, the rules Calderyn picks up about how you run your shop will
          show here.
        </div>
      ) : (
        rules.map((rule) => (
          <div key={rule.id} className="aqx-rule">
            <span className="aqx-rule-ico">
              <IShield />
            </span>
            <span className="aqx-rule-text">{rule.summary}</span>
            <undoFetcher.Form method="post">
              <input type="hidden" name="intent" value="undo-rule" />
              <input type="hidden" name="ruleId" value={rule.id} />
              <button type="submit" className="aqx-rule-undo">
                <IUndo /> Undo
              </button>
            </undoFetcher.Form>
          </div>
        ))
      )}
    </div>
  );
}

/* ---------- screen ---------- */
function Stack({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>{children}</div>;
}

export default function ActionQueue() {
  const { proposals, learnedRules, calibrationPct, nearGraduation, error } = useLoaderData<typeof loader>();
  // Hold the worked-through list stable so a card's reflection receipt isn't
  // wiped by the loader revalidation that fires after each approve/reject.
  // Highest confidence first (matches the design's ranking note).
  const [items] = useState(() => [...proposals].sort((a, b) => b.confidence - a.confidence));
  // The most recent pair to cross into graduated this session drives the
  // celebratory "autopilot unlocked" moment at the top of the queue.
  const [graduated, setGraduated] = useState<GraduatedInfo | null>(null);

  return (
    <Page title="Action Queue">
      <Stack>
        <CalibrationLevelHeader pct={calibrationPct} nearGraduation={nearGraduation} />

        {graduated && <GraduationMoment info={graduated} onDismiss={() => setGraduated(null)} />}

        {error && (
          <Banner tone="critical" title="Couldn't load the queue">
            <p>{error.message}</p>
          </Banner>
        )}

        {!error && items.length === 0 ? (
          <div className="aqx-card">
            <div className="aqx-empty">
              <p className="aqx-empty-title">Nothing needs you right now</p>
              <p className="aqx-empty-text">
                Calderyn will line up suggestions here as it spots money leaks. Approving and rejecting them trains your
                agent.
              </p>
            </div>
          </div>
        ) : (
          <div>
            <div className="aqx-head">
              <div className="aqx-head-title">
                <h2>{items.length} waiting</h2>
                <span className="aqx-head-sub">need your OK</span>
              </div>
              <span className="aqx-head-rank">Highest confidence first</span>
            </div>
            <div className="aqx-list">
              {items.map((p) => (
                <ProposalCard key={`${p.alertId}:${p.action_kind}`} p={p} onGraduated={setGraduated} />
              ))}
            </div>
          </div>
        )}

        <LearnedRules rules={learnedRules} />
      </Stack>
    </Page>
  );
}
