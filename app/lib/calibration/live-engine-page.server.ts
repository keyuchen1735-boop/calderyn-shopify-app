// Shared, server-only assembler for the Live Engine page. This is the SINGLE
// source of the page's data contract, called by BOTH surfaces — the embedded
// route loader (app.engine.tsx) and the dashboard API loader
// (dashboard.api.live-engine) — so the two can never drift. Everything it returns
// is plain and JSON-serializable.
//
// Truthfulness policy (Calderyn moves real money, so the page shows only real
// state — no fabricated activity):
//   * Autopilot features + money protected: REAL (calibration.liveEngine reads
//     graduated pairs + autopilot rows in v_audit_view).
//   * Trace "what Calderyn just did": REAL durable audit rows ONLY. The engine's
//     per-step WATCH/DETECT/SCORE trace is not persisted, so we never invent it;
//     the trace shows actions that actually happened (autopilot, your approvals,
//     undos, blocked attempts).
//   * Pipeline "how it weighs a call": REAL confidence breakdowns over current
//     decisions; the gate shown is each pair's REAL graduation_threshold.
//   * Predictions "what it sees coming": REAL derived signals only — inventory
//     runway (projectedStockoutDate), open alerts, campaigns below breakeven.
//     No invented probabilities; empty when there is nothing to show.
//
// Every section is best-effort via Promise.allSettled: a failing read degrades
// that one section to empty rather than breaking the page.
import type { calderynClient } from "../calderyn.server";
import type { ActionKind, AuditEntry } from "../types";
import { pairConfidenceBreakdown } from "./confidence";
import { effectiveGraduationThreshold } from "./graduation";
import { isUuid } from "../ids";
import { ACTION_LABELS, DETECTOR_LABELS } from "../labels";
import { projectedStockoutDate, formatStockoutDate } from "../inventory-demand";
import { fmtMoney } from "../format";
import { graduationProgress } from "./progress";
import { buildWatchScan } from "./watch-scan";
import {
  pendingEvidenceStats,
  pendingApproveText,
  PENDING_DENY_TEXT,
  PENDING_TRUST_LINE,
} from "./pending-inspector";
import type {
  LiveEnginePageData,
  LiveEngineFeatureVM,
  PipelineCallVM,
  TraceEventVM,
  TraceTag,
  PredictionVM,
  PendingInspectorVM,
} from "./live-engine-types";

// Re-export the browser-safe VM contract so the embedded route can keep
// importing it from here; the dashboard (browser) imports straight from
// ./live-engine-types to avoid pulling in this .server module.
export type {
  LiveEnginePageData,
  LiveEngineFeatureVM,
  PipelineCallVM,
  PipelineFactorVM,
  TraceEventVM,
  TraceTag,
  PredictionVM,
  PredictionTone,
  PendingInspectorVM,
  InspectorStat,
} from "./live-engine-types";

type Client = ReturnType<typeof calderynClient>;

const EMPTY: LiveEnginePageData = {
  autopilotEnabled: false,
  moneyProtectedWeekCents: 0,
  features: [],
  pipeline: [],
  trace: [],
  pending: [],
  predictions: [],
  watchScan: { inv: [], ads: [], price: [], ret: [] },
  calibrationPct: null,
  nearGraduation: 0,
};

/* ---------- small pure helpers ---------- */

function clock(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function relTime(iso: string | null, now: number): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function traceTag(e: AuditEntry): TraceTag {
  if (e.undo_of) return "UNDONE";
  if (e.outcome === "failed") return "BLOCKED";
  if (e.actor === "autopilot") return "AUTO";
  return "APPROVED";
}

function decisionCopy(tag: TraceTag, failureReason?: string): { label: string; note: string } {
  switch (tag) {
    case "AUTO":
      return {
        label: "DONE AUTOMATICALLY",
        note: "This pair graduated to autopilot, so Calderyn acted the moment it spotted the problem and logged it for you. You can undo it from your action history.",
      };
    case "APPROVED":
      return {
        label: "YOU APPROVED THIS",
        note: "You approved this in the Action Queue. Each approval like this moves the pair closer to running on its own.",
      };
    case "UNDONE":
      return {
        label: "REVERSED",
        note: "This action was undone. Calderyn treats that as a strong signal and gets more cautious about this kind of call.",
      };
    case "BLOCKED":
      return {
        label: "DID NOT RUN",
        note: failureReason
          ? `This did not complete: ${failureReason}. Calderyn left everything as it was.`
          : "This did not complete, so Calderyn left everything as it was and will try again later.",
      };
  }
}

/* ---------- the builder ---------- */

/**
 * Assemble the full Live Engine page data from the shop-scoped facade. `now` is
 * injectable for tests. Never throws — returns EMPTY on a catastrophic failure
 * and degrades each section independently on a partial one.
 */
export async function buildLiveEnginePageData(
  client: Client,
  signal?: AbortSignal,
  now: number = Date.now(),
): Promise<LiveEnginePageData> {
  try {
    const [summaryR, pairsR, calR, nearR, proposalsR, auditR, skusR, alertsR, gradesR, campaignsR] =
      await Promise.allSettled([
        client.calibration.liveEngine(),
        client.calibration.pairEvidence(),
        client.calibration.get(signal),
        client.calibration.nearGraduation(),
        client.queue.list(signal),
        client.audit.list(signal),
        client.skus.list(signal),
        client.alerts.list({ status: "open" }, signal),
        client.analytics.campaignGrades(signal),
        client.campaigns.list(signal),
      ]);

    const summary = summaryR.status === "fulfilled" ? summaryR.value : null;
    const pairEv = pairsR.status === "fulfilled" ? pairsR.value : [];
    const calibrationPct = calR.status === "fulfilled" ? calR.value.pct : null;
    const nearGraduation = nearR.status === "fulfilled" ? nearR.value : 0;
    const proposals = proposalsR.status === "fulfilled" ? proposalsR.value : [];
    const audit = auditR.status === "fulfilled" ? auditR.value : [];
    const skus = skusR.status === "fulfilled" ? skusR.value : [];
    const openAlerts = alertsR.status === "fulfilled" ? alertsR.value : [];
    const grades = gradesR.status === "fulfilled" ? gradesR.value : [];
    const campaigns = campaignsR.status === "fulfilled" ? campaignsR.value : [];
    const watchScan = buildWatchScan(
      skus.map((s) => ({ title: s.title, onHand: s.on_hand, velocity: s.velocity, shipPnlCents: s.ship_pnl_cents })),
      campaigns.map((c) => ({ name: c.name, roas7d: c.roas_7d, status: c.status })),
    );

    /* Some audit rows carry a bare entity id (campaign uuid, sku_dim uuid) as
       their target. Resolve ids to the display names the rest of the app uses
       (campaign name, SKU title) from the rows already loaded above; anything
       unresolvable is omitted entirely rather than shown as a raw uuid. */
    const targetNames = new Map<string, string>();
    for (const s of skus) {
      const label = s.title || s.sku;
      if (s.id && label) targetNames.set(String(s.id).toLowerCase(), label);
    }
    for (const c of campaigns) {
      if (c.id && c.name) targetNames.set(String(c.id).toLowerCase(), c.name);
    }
    const displayTarget = (raw: string | null | undefined): string => {
      const t = (raw ?? "").trim();
      if (!isUuid(t)) return t;
      return targetNames.get(t.toLowerCase()) ?? "";
    };

    const evMap = new Map(pairEv.map((p) => [`${p.detectorId}:${p.actionKind}`, p]));
    const breakdownFor = (detectorId: string, actionKind: ActionKind) => {
      const ev = evMap.get(`${detectorId}:${actionKind}`);
      // Same cached learned factors the queue/recompute score with, and the
      // tier-floored bar the gate actually enforces — the inspector must never
      // show a different number or a lower bar than the real gate.
      const bd = pairConfidenceBreakdown(
        detectorId,
        actionKind,
        { alpha: ev?.alpha ?? 0, beta: ev?.beta ?? 0 },
        null,
        {
          detection: ev?.lastDetection,
          consecutiveCleanApprovals: ev?.consecutiveCleanApprovals,
        },
      );
      return {
        bd,
        threshold: effectiveGraduationThreshold(actionKind, ev?.graduationThreshold ?? 0),
      };
    };

    /* features */
    const features: LiveEngineFeatureVM[] = (summary?.features ?? []).map((f) => {
      const prog = graduationProgress(f.actionKind, f.cleanApprovals, f.netPositiveOutcomes);
      return {
        detectorId: f.detectorId,
        actionKind: f.actionKind,
        name: f.name,
        watching: f.watching,
        enabled: f.enabled,
        recommended: f.recommended,
        moneyCents: f.moneyCents,
        actions: f.actions,
        lastAt: f.lastAt,
        lastText: f.lastAt ? `last acted ${relTime(f.lastAt, now)}` : "no actions yet",
        ...prog,
      };
    });

    /* pipeline: blend the live "ask you" branch (open proposals, below their bar)
       with the "handle it" branch (recent autopilot actions, above their bar), so
       the graph honestly shows both outcomes when both exist. */
    const autoForPipeline = audit
      .filter((e) => e.actor === "autopilot" && !e.undo_of && e.outcome !== "failed" && e.detector_id)
      .slice(0, 2)
      .map((e) => {
        const { bd, threshold } = breakdownFor(e.detector_id, e.action_kind);
        const label = ACTION_LABELS[e.action_kind] ?? e.action_kind;
        const subject = displayTarget(e.target) || DETECTOR_LABELS[e.detector_id] || "";
        return {
          detectorId: e.detector_id,
          actionKind: e.action_kind,
          title: subject ? `${label}: ${subject}` : label,
          context: e.trigger_reason || DETECTOR_LABELS[e.detector_id] || "Handled on its own",
          factors: bd.factors,
          confidence: bd.confidence,
          threshold,
          auto: true,
        } satisfies PipelineCallVM;
      });
    const askForPipeline = proposals.slice(0, 4).map((p) => {
      const { bd, threshold } = breakdownFor(p.detector_id, p.action_kind);
      return {
        detectorId: p.detector_id,
        actionKind: p.action_kind,
        title: p.title || (ACTION_LABELS[p.action_kind] ?? p.action_kind),
        context: p.reasoning,
        factors: bd.factors,
        confidence: p.confidence,
        threshold,
        auto: p.confidence >= threshold,
      } satisfies PipelineCallVM;
    });
    const pipeline = [...autoForPipeline, ...askForPipeline].slice(0, 6);

    /* trace: real durable audit rows, newest first */
    const trace: TraceEventVM[] = audit.slice(0, 40).map((e) => {
      const tag = traceTag(e);
      const actionLabel = ACTION_LABELS[e.action_kind] ?? e.action_kind;
      const detectorLabel = e.detector_id ? DETECTOR_LABELS[e.detector_id] ?? e.detector_id : "";
      const target = displayTarget(e.target);
      const money = Number(e.dollar_impact_at_exec ?? 0); // already cents
      const dec = decisionCopy(tag, e.failure_reason);

      let text: string;
      if (tag === "AUTO") text = `${actionLabel}${target ? `: ${target}` : ""}`;
      else if (tag === "APPROVED") text = `You approved ${actionLabel.toLowerCase()}${target ? ` on ${target}` : ""}`;
      else if (tag === "UNDONE") text = `Undid ${actionLabel.toLowerCase()}${target ? ` on ${target}` : ""}`;
      else text = `${actionLabel}${target ? ` on ${target}` : ""} did not go through`;

      const hasPair = Boolean(e.detector_id);
      const { bd, threshold } = hasPair
        ? breakdownFor(e.detector_id, e.action_kind)
        : { bd: null, threshold: 80 };

      const signal =
        e.trigger_reason ||
        (detectorLabel ? `Flagged by: ${detectorLabel}.` : `Manual ${actionLabel.toLowerCase()}.`);
      const evidence = [
        target ? `Target: ${target}` : null,
        detectorLabel ? `Detector: ${detectorLabel}` : null,
        money ? `${fmtMoney(Math.abs(money))} impact` : null,
      ].filter((x): x is string => x !== null);

      return {
        id: e.id,
        tag,
        detectorId: e.detector_id,
        actionKind: e.action_kind,
        text,
        moneyCents: money,
        time: clock(e.created_at),
        rel: relTime(e.created_at, now),
        title: `${actionLabel}${target ? ` · ${target}` : ""}`,
        signal,
        evidence,
        factors: bd ? bd.factors : null,
        confidence: bd ? bd.confidence : null,
        threshold,
        decisionLabel: dec.label,
        decisionNote: dec.note,
      };
    });

    /* pending: flagged proposals awaiting approval, shaped for the simplified
       inspector. Each is joined to its open alert for the narrative + humanized
       evidence figures; the bar comes from the pair's real graduation threshold.
       Same shared assembly as the dashboard's client-side inspector. */
    const alertById = new Map(openAlerts.map((a) => [a.id, a]));
    const pending: PendingInspectorVM[] = proposals.map((p) => {
      const alert = alertById.get(p.alertId);
      const { threshold } = breakdownFor(p.detector_id, p.action_kind);
      const actionLabel = ACTION_LABELS[p.action_kind] ?? p.action_kind;
      return {
        alertId: p.alertId,
        detectorId: p.detector_id,
        actionKind: p.action_kind,
        title: p.title || actionLabel,
        actionLabel,
        dollarImpactCents: p.dollar_impact,
        confidence: p.confidence,
        threshold,
        signal: alert?.narrative || p.reasoning,
        stats: pendingEvidenceStats(alert?.evidence),
        approveText: pendingApproveText(actionLabel),
        denyText: PENDING_DENY_TEXT,
        trustLine: PENDING_TRUST_LINE,
      };
    });

    /* predictions: derived from real forward-looking signals only */
    const predictions: PredictionVM[] = [];
    // (a) inventory runway — the only legitimate forward number
    const stockouts = skus
      .filter((s) => s.velocity > 0 && Number.isFinite(s.days_of_cover) && s.days_of_cover < 999 && s.days_of_cover <= 21)
      .sort((a, b) => a.days_of_cover - b.days_of_cover)
      .slice(0, 2);
    for (const s of stockouts) {
      const days = Math.max(0, Math.round(s.days_of_cover));
      const iso = projectedStockoutDate(s.days_of_cover, s.velocity, new Date(now));
      predictions.push({
        kind: "stockout",
        text: `${s.title || s.sku} runs out in about ${days} ${days === 1 ? "day" : "days"}`,
        detail: iso ? `~${formatStockoutDate(iso, new Date(now))}` : "soon",
        tone: "warn",
      });
    }
    // (b) campaigns currently below breakeven
    const slipping = grades
      .filter((g) => Number.isFinite(g.roas) && Number.isFinite(g.break_even_roas) && g.roas < g.break_even_roas)
      .slice(0, 2);
    for (const g of slipping) {
      predictions.push({
        kind: "campaign",
        text: `${g.name} is running below breakeven`,
        detail: `ROAS ${g.roas.toFixed(1)} vs ${g.break_even_roas.toFixed(1)} needed`,
        tone: "down",
      });
    }
    // (c) the biggest open alert Calderyn is about to act on
    const topAlert = [...openAlerts].sort((a, b) => b.dollar_impact - a.dollar_impact)[0];
    if (topAlert && predictions.length < 5) {
      predictions.push({
        kind: "alert",
        text: topAlert.title || topAlert.narrative,
        detail: topAlert.dollar_impact ? `${fmtMoney(topAlert.dollar_impact)} at stake` : "in your queue",
        tone: "down",
      });
    }

    return {
      autopilotEnabled: summary?.autopilotEnabled ?? false,
      moneyProtectedWeekCents: summary?.moneyProtectedWeekCents ?? 0,
      features,
      pipeline,
      trace,
      pending,
      predictions,
      watchScan,
      calibrationPct,
      nearGraduation,
    };
  } catch {
    return EMPTY;
  }
}
