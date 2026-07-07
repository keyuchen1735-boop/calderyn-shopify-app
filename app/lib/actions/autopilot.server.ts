// Auto-pilot: for an opted-in shop, scan open money-losing alerts and act within
// guardrails, attributing every action to "autopilot". Reads candidates from the
// v_autopilot_candidates view (alert + campaign + 7d spend + current budget).

import type { SupabaseClient } from "@supabase/supabase-js";
import { getActionPolicy } from "./action-policy.server";
import { checkGuardrails, checkPriceInventoryGuardrails } from "./guardrails.server";
import { executeAction, type ExecutableKind, type ExecutedAudit } from "./execute.server";
import { executeReallocation } from "./reallocate.server";
import {
  loadReallocationCandidates,
  pickReallocation,
} from "./reallocation-suggest.server";
// Main's scoped resolver synthesises campaign targets for campaign-less
// ad_tax_overload alerts. Its Candidate is ad_tax_overload-specific (no
// evidence/sku/sku_id), so it is aliased — the merged `Candidate` below is the
// one the loop and tryRemediation use.
import { resolveScopedCandidates } from "./autopilot-targeting.server";
import { DETECTOR_LABELS } from "../labels";
import { rankMoves, toNumericEvidence } from "../remediation/rank";
import { enrichRemediation } from "../remediation/enrich.server";
import type { MoveKind, StrategicMove } from "../remediation/types";
import { remediationReason } from "./remediation-reason";
import { checkSkuGuardrails } from "./remediation-guard.server";
import { executeDiscontinueAlertAction, executeInventoryAlertAction } from "./alert-action.server";
import { executeReallocateSpendSku } from "./reallocate-sku.server";
import { executeAdjustPriceAlertAction, resolveSkuVariant } from "./adjust-price.server";
import { suggestAdjustPrice } from "../remediation/price";
import { readVariantPrice } from "../shopify/price.server";
import { getCurrentUnitCostCents } from "../po/draft.server";
import { transferPlanFromEvidence } from "../shopify/inventory.server";
import { reallocationPlanFromEvidence } from "../weather/reallocation-plan";
import { campaignSpend7dCents, resolveDedicatedCampaign } from "./dedicated-campaign.server";
import { calderynClient } from "../calderyn.server";
import type { Alert, DetectorId } from "../types";
import { isGraduated } from "../calibration/graduation.server";
import { calibrationActionKind } from "../calibration/action-kind";
import { recordActionFailure } from "../calibration/failure.server";
import { preconditionFresh, stockoutPauseAllowed, stockoutClearedResumeAllowed } from "../calibration/preconditions.server";
import { loadAndApplyRules } from "./rule-enforce.server";
import { notifyAutonomousAction } from "../calibration/notify-autonomous.server";
import { acquireAutopilotLock, releaseAutopilotLock } from "./autopilot-lock.server";

const PAUSE_DETECTORS = new Set([
  "campaign_below_breakeven",
  "negative_unit_economics",
  "sku_stockout_vs_spend",
]);
const BUDGET_DETECTORS = new Set(["ad_tax_overload"]);
const SCALE_DETECTORS = new Set(["campaign_scaling_opportunity"]);
// Slice B: resume a campaign Calderyn auto-paused for a stockout once the SKU is
// restocked. resume_campaign restarts spend, so it is gated like every other
// autonomous kind (graduation + rules + guardrails + a live precondition).
const RESUME_DETECTORS = new Set(["sku_stockout_cleared"]);
const DEFAULT_MAX_CUT_PCT = 50; // mirrors the config default; the guardrail check enforces the live value
const DEFAULT_MAX_INCREASE_PCT = 20;

const PRODUCT_ECON_DETECTORS = new Set<DetectorId>([
  "negative_unit_economics",
  "ad_tax_overload",
  "return_rate_hidden_loss",
  "margin_erosion",
  "cogs_drift",
]);

// Inventory-relocation detectors whose remediation is a physical stock move
// (reallocate_inventory). These are NOT product-economics detectors, so they
// never reach tryRemediation; tryInventoryRelocation handles them via the
// dedicated executeInventoryAlertAction seam.
export const INVENTORY_RELOCATION_DETECTORS = new Set<DetectorId>([
  "sku_stockout_vs_spend",
  "regional_shortage_risk",
  "regional_spend_starved_stock",
  "scaling_sku_fulfillment_risk",
  "wrong_location_concentration",
  "weather_demand",
]);

/** Per-candidate decision outcome. "skipped" = a pre-flight refusal (no
 *  guardrail call); "blocked" = a guardrail verdict refused it; "failed" = the
 *  executor was called but did not land (outcome "failed"/"retrying", or threw). */
export type AutopilotOutcome = "acted" | "blocked" | "skipped" | "failed";

/** One structured decision per candidate considered, so a silent run is
 *  auditable (rule 12: fail visibly). */
export interface AutopilotDecision {
  alertId: string;
  /** Null for SKU-only economics alerts that carry no campaign. */
  campaignId: string | null;
  detectorId: string;
  intendedKind: ExecutableKind | null;
  outcome: AutopilotOutcome;
  reason: string;
}

export interface AutopilotSummary {
  skipped: boolean;
  /** Actions that actually LANDED on the platform (executor outcome "succeeded"). */
  acted: number;
  /** Candidates a guardrail or pre-flight check refused (no budget written). */
  blocked: number;
  /** Remediation recommendations that were advisory/non-executable and not acted
   *  on (distinct from `blocked`, which is a guardrail/cap/precondition refusal). */
  skippedMoves: number;
  /** Attempted but did not land: executor returned "failed"/"retrying", or threw. */
  failed: number;
  /** Total candidates evaluated this run (one decision recorded per candidate). */
  considered: number;
  /** Why each blocked candidate was refused, keyed by reason — covers the full
   *  `blocked` total (guardrail verdicts AND pre-flight skips), so
   *  `sum(blockedReasons) === blocked`. */
  blockedReasons: Record<string, number>;
  /** Structured decision for every candidate considered. */
  decisions: AutopilotDecision[];
}

interface Candidate {
  alert_id: string;
  detector_id: string;
  dollar_impact: number; // dollars
  campaign_id: string | null; // nullable: SKU-only economics alerts have no campaign
  campaign_spend_cents: number;
  daily_budget_cents: number | null;
  // New (Task 3 view): for the remediation plan + SKU targeting. Optional so the
  // synthetic scoped candidates (which lack them) still satisfy the type.
  evidence?: Record<string, unknown> | null;
  sku?: string | null;
  sku_id?: string | null;
}

// Maps a plan move's executor to a guarded execution. The `outcome` is one of
// "acted" | "blocked" | "skipped" | "failed" | "fell_through"; "fell_through"
// means "not an executable remediation move — let the legacy campaign logic
// handle it"; "failed" means the executor was called but the action did not
// land (platform error / parked as retrying). The `reason` is a plain-language
// line for the structured decision / blockedReasons histogram (rule 12: every
// blocked/skipped path is explained).
type RemediationOutcome = "acted" | "blocked" | "skipped" | "failed" | "fell_through";
interface RemediationResult {
  outcome: RemediationOutcome;
  reason: string;
}

/** Try to act on the candidate's stored remediation recommendation. Returns
 *  whether it acted/blocked/skipped (with a reason), or "fell_through" to defer
 *  to the legacy campaign logic. The decision is the Phase-1 plan + the Phase-3
 *  enrichment — we never re-rank or re-resolve the winner/campaign here
 *  (re-deriving would drift from the merchant path, which routes the *same*
 *  enriched move). */
async function tryRemediation(
  shopId: string,
  c: Candidate,
  sb: SupabaseClient,
  merchantEmail: string | null,
  notifyPromises: Promise<void>[],
): Promise<RemediationResult> {
  if (!PRODUCT_ECON_DETECTORS.has(c.detector_id as DetectorId))
    return { outcome: "fell_through", reason: "not a product-economics detector" };

  // Reuse the Phase-1 engine on the candidate's own evidence — identical input
  // to attachRemediation(), so autopilot and the UI agree on the recommendation.
  const dollarImpactCentsAlert = Math.round(Number(c.dollar_impact) * 100);
  const basePlan = rankMoves({
    detectorId: c.detector_id as DetectorId,
    dollarImpactCents: dollarImpactCentsAlert,
    evidence: toNumericEvidence(c.evidence ?? {}),
  });

  // Phase-3 enrichment fills the executable target + flips executor null →
  // "reallocate_spend_sku"/cut kinds. Phase 4 calls the SAME resolver the
  // merchant detail paths call — it does NOT re-derive the winner/campaign
  // itself (re-deriving here would drift from the merchant path). enrich takes
  // an Alert-shaped object; the candidate row carries everything it reads
  // (id, detector_id, dollar_impact, evidence with sku_id).
  const alertForEnrich = {
    id: c.alert_id,
    detector_id: c.detector_id as DetectorId,
    dollar_impact: dollarImpactCentsAlert,
    evidence: { ...(c.evidence ?? {}), sku_id: c.sku_id ?? undefined },
  } as unknown as Alert;
  const plan = await enrichRemediation(alertForEnrich, basePlan, sb, shopId);

  const recommended = plan.recommended;
  if (!recommended) {
    // Only snooze applies → nothing to automate. Surface, don't drop (rule 12).
    console.info(`[autopilot] remediation skip on alert ${c.alert_id}: no recommended move`);
    return { outcome: "skipped", reason: "remediation: no recommended move" };
  }
  let move: StrategicMove | undefined = plan.moves.find((m) => m.kind === recommended);

  // Advisory / not-yet-executable recommendation (executor null, or snooze):
  // autopilot does not auto-snooze and does not act on advisory moves. Before
  // deferring, fall back to the plan's cut_ads leg when enrichment made IT
  // executable — a pause/reduce of the SKU's dedicated campaign, resolved from
  // the trusted v_sku_remediation_inputs view (never request input). This is
  // how a SKU-scoped money-loser reaches its own pause pair even when the
  // cross-campaign reallocation stays advisory (no qualifying winner /
  // non-Meta loser). Without an executable cut either, fall through so the
  // legacy campaign logic can still pause/reduce if applicable.
  if (!move || move.executor == null || move.executor === "snooze_alert") {
    const cut = plan.moves.find(
      (m) =>
        m.kind === "cut_ads" &&
        (m.executor === "pause_campaign" || m.executor === "reduce_campaign_budget") &&
        typeof m.target?.loserCampaignId === "string",
    );
    if (!cut) {
      console.info(
        `[autopilot] remediation skip on alert ${c.alert_id}: recommended ${recommended} is advisory/non-executable`,
      );
      return {
        outcome: "fell_through",
        reason: `remediation: ${recommended} is advisory/non-executable`,
      };
    }
    console.info(
      `[autopilot] remediation fallback on alert ${c.alert_id}: ${recommended} is advisory — trying executable ${cut.executor} on the SKU's dedicated campaign`,
    );
    move = cut;
  }
  // Defensive re-narrow: both branches above guarantee an executable, non-snooze
  // move (the compiler cannot see through the find() predicates).
  if (move.executor == null || move.executor === "snooze_alert") {
    return { outcome: "skipped", reason: "remediation: no executable move" };
  }

  // Campaign target for the campaign-scoped executors below. The enriched
  // cut/reallocate legs carry the SKU's dedicated campaign in move.target
  // (trusted view data); candidates keyed to a campaign use their own.
  const remCampaignId =
    typeof move.target?.loserCampaignId === "string" ? move.target.loserCampaignId : c.campaign_id;
  // When acting on a resolved campaign the candidate row's spend/budget belong
  // to a DIFFERENT campaign (or none) — re-derive both for the target so the
  // min-spend guardrail and the budget-snapshot freshness check stay honest.
  const usingResolvedCampaign =
    remCampaignId != null &&
    remCampaignId !== c.campaign_id &&
    (move.executor === "pause_campaign" || move.executor === "reduce_campaign_budget");
  let remCampaignSpendCents = c.campaign_spend_cents ?? 0;
  let remCampaignBudgetCents = c.daily_budget_cents ?? null;
  if (usingResolvedCampaign) {
    const spend = await campaignSpend7dCents(sb, shopId, remCampaignId);
    if (spend == null) {
      // Fail-closed: cannot verify the target campaign's spend → do not act.
      console.info(
        `[autopilot] remediation skip on alert ${c.alert_id}: could not verify dedicated-campaign spend`,
      );
      return { outcome: "skipped", reason: "remediation: dedicated-campaign spend unavailable" };
    }
    remCampaignSpendCents = spend;
    remCampaignBudgetCents =
      typeof move.target?.loserCampaignBudgetCents === "number"
        ? move.target.loserCampaignBudgetCents
        : null;
    // Audited decision must name the campaign actually touched (see decide()).
    (c as Candidate & { _resolvedCampaignId?: string })._resolvedCampaignId = remCampaignId;
  }

  const dollarImpactCents = move.dollarImpactCents;
  const reason = remediationReason(plan, move.kind as MoveKind, c.detector_id as DetectorId);
  const idempotencyKey = `autopilot:${c.alert_id}:${move.executor}`;

  // Graduation gate (Slice 5 parity): an executable remediation move MUST NOT
  // bypass calibration's safety model. Gate it on the SAME isGraduated check the
  // legacy autonomous path applies — keyed on the kind the move is calibrated +
  // audited under (calibrationActionKind: reallocate_spend_sku → reallocate_budget,
  // every other executor is its own action_kind enum value). The SAME normalizer
  // keys the merchant approval write, so the two never train different pairs.
  // isGraduated is fail-safe (false on any read error), so a DB hiccup can never
  // grant remediation autonomy. NOT graduated → record a
  // structured skip (the caller buckets this as `skippedMoves`, not a guardrail
  // block) and the candidate is fully resolved — it does NOT fall through, because
  // the detector's legacy path is graduation-gated too and would also skip;
  // falling through would double-evaluate the same alert. In v1 (nothing
  // graduated) autopilot-remediation is therefore dormant, consistent with the
  // rest of the autonomy system. Merchant-facing remediation (panels / manual
  // execution) is UNAFFECTED — this gate is autopilot-only.
  const graduationKind = calibrationActionKind(move.executor);
  if (!(await isGraduated(shopId, c.detector_id, graduationKind, sb))) {
    console.info(
      `[autopilot] remediation skip on alert ${c.alert_id}: pair (${c.detector_id}/${graduationKind}) not graduated`,
    );
    return { outcome: "skipped", reason: "remediation pair not graduated" };
  }

  // Learned-rule enforcement: the merchant's calibration_rule rows govern EVERY
  // autonomous execute path, not just the legacy campaign loop. Keyed on the
  // SAME normalized kind the pair is trained under (graduationKind), so a rule
  // written by a reject always binds the path that fires. Fail-safe: an
  // unloadable rule set returns { veto: "rules unavailable" } and we skip.
  // pair_dollar_cap on reduce_campaign_budget downsizes instead of vetoing —
  // the cap is stashed here and applied where newBudgetCents is computed below.
  let remediationCappedDollarCents: number | undefined;
  let remediationMuOverride = 1;
  {
    const nowUtc = new Date();
    const ruleVerdict = await loadAndApplyRules(
      shopId,
      c.detector_id,
      graduationKind,
      {
        dollarImpactCents,
        campaignSpendCents: remCampaignSpendCents,
        nowUtcHour: nowUtc.getUTCHours(),
        nowIso: nowUtc.toISOString(),
      },
      sb,
    );
    if (ruleVerdict.veto) {
      console.info(
        `[autopilot] remediation rule veto on alert ${c.alert_id} (${c.detector_id}/${graduationKind}): ${ruleVerdict.veto}`,
      );
      return { outcome: "skipped", reason: `rule: ${ruleVerdict.veto}` };
    }
    remediationCappedDollarCents = ruleVerdict.cappedDollarCents;
    if (ruleVerdict.muOverride !== undefined) remediationMuOverride = ruleVerdict.muOverride;
  }

  // SKU-scoped move (discontinue_sku): SKU guard, no campaign needed. The Phase-2
  // gateway takes a single opts object with a `client` (slice of calderynClient)
  // and a Shopify `admin` client; it re-derives the product GID from the alert's
  // own SKU record (never request input). Autopilot passes the alert id + reason.
  if (move.executor === "discontinue_sku") {
    if (!c.sku_id) {
      console.info(`[autopilot] remediation block on alert ${c.alert_id}: discontinue_sku has no sku_id`);
      return { outcome: "blocked", reason: "remediation: discontinue_sku has no sku_id" };
    }
    const verdict = await checkSkuGuardrails(shopId, { dollarImpactCents }, sb);
    if (!verdict.allowed) {
      console.info(`[autopilot] remediation block on alert ${c.alert_id}: ${verdict.reason}`);
      return { outcome: "blocked", reason: verdict.reason ?? "remediation: blocked by SKU guardrails" };
    }
    const client = calderynClient(shopId);
    const { admin } = await (await import("~/shopify.server")).unauthenticated.admin(shopId);
    const discontinueRes = await executeDiscontinueAlertAction({
      client,
      admin,
      sb,
      shopId,
      alertId: c.alert_id,
      kind: "discontinue_sku",
      idempotencyKey,
      actor: "autopilot",
      triggerReason: reason,
    });
    // The gateway resolves with { outcome } for platform failures it recorded
    // (throws only cover pre-audit faults) — never notify or count a non-landed
    // action as acted, and record the terminal failure as a beta signal (§7).
    if (discontinueRes.outcome !== "succeeded") {
      if (discontinueRes.outcome === "failed") {
        notifyPromises.push(
          recordActionFailure(shopId, c.detector_id, graduationKind, sb, {
            auditId: discontinueRes.auditId,
            alertId: c.alert_id,
          }),
        );
      }
      return { outcome: "failed", reason: `executor outcome: ${discontinueRes.outcome}` };
    }
    // I7: every autonomous action notifies the merchant at execution time.
    notifyPromises.push(
      notifyAutonomousAction(
        { shopId, actionDescription: `Discontinued SKU ${c.sku ?? c.sku_id ?? "(unknown)"}` },
        merchantEmail,
      ).catch((e) => console.error("[autopilot-notify] unexpected error (discontinue_sku)", e)),
    );
    return { outcome: "acted", reason };
  }

  // SKU-scoped price move (adjust_price): raise a SKU's selling price to restore
  // its pre-erosion margin (margin_erosion / cogs_drift). No campaign needed.
  //
  // BLOCK-NOT-CLAMP (spec §2.4): an over-cap price move is routed to the merchant
  // queue, never clamped down and fired. To do that we PREDICT the exact price
  // the executor would apply, then check the predicted % change against the
  // autonomous cap. The executor recomputes the identical suggestion from the
  // SAME inputs (live price + COGS + the merchant confirm cap
  // guardrails.max_price_change_pct), so the prediction here is byte-for-byte the
  // price that lands — no override is passed.
  if (move.executor === "adjust_price") {
    if (!c.sku) {
      return { outcome: "blocked", reason: "adjust_price: alert has no SKU" };
    }
    const client = calderynClient(shopId);
    const { admin } = await (await import("~/shopify.server")).unauthenticated.admin(shopId);

    const target = await resolveSkuVariant(sb, shopId, c.sku);
    if (!target) {
      return { outcome: "blocked", reason: "adjust_price: SKU has no linked variant" };
    }
    const { priceCents: priorPriceCents } = await readVariantPrice(admin, target.variantGid);
    const currentCogsCents = await getCurrentUnitCostCents(sb, shopId, c.sku);

    // Mirror the executor's suggestion inputs EXACTLY: capPct is the merchant
    // confirm cap (guardrails.max_price_change_pct), the same value
    // executeAdjustPriceAlertAction passes — so the predicted price equals the
    // applied price. The autonomous cap is enforced separately below.
    const merchantGuardrails = await client.guardrails.get();
    const suggestion = suggestAdjustPrice({
      detectorId: c.detector_id as DetectorId,
      evidence: toNumericEvidence(c.evidence ?? {}),
      currentPriceCents: priorPriceCents,
      currentCogsCents,
      capPct: merchantGuardrails.max_price_change_pct,
    });
    if (!suggestion) {
      return { outcome: "blocked", reason: "adjust_price: no price suggestion" };
    }

    // Signed change vs the prior price; the autonomous cap blocks an over-cap move.
    const priceChangePct =
      ((suggestion.newPriceCents - priorPriceCents) / priorPriceCents) * 100;
    const verdict = await checkPriceInventoryGuardrails(
      shopId,
      { kind: "adjust_price", dollarImpactCents: dollarImpactCents, priceChangePct },
      sb,
    );
    if (!verdict.allowed) {
      // Over cap (or another guardrail): do NOT execute, do NOT acknowledge —
      // the alert stays open for merchant approval (§2.4).
      console.info(`[autopilot] remediation block on alert ${c.alert_id}: ${verdict.reason}`);
      return { outcome: "blocked", reason: verdict.reason ?? "adjust_price: blocked by guardrails" };
    }

    // The executor recomputes the identical suggestion (same live price + COGS +
    // merchant cap) and applies the predicted price. It throws on pre-audit
    // faults, but a platform failure it recorded RESOLVES with { outcome } —
    // never notify or count a non-landed price change as acted, and record the
    // terminal failure as a beta signal (§7).
    const triggerReason = autopilotReason("Auto adjust price", c.detector_id, c.dollar_impact);
    const priceRes = await executeAdjustPriceAlertAction({
      client,
      admin,
      sb,
      shopId,
      alertId: c.alert_id,
      kind: "adjust_price",
      idempotencyKey,
      actor: "autopilot",
      triggerReason,
    });
    if (priceRes.outcome !== "succeeded") {
      if (priceRes.outcome === "failed") {
        notifyPromises.push(
          recordActionFailure(shopId, c.detector_id, graduationKind, sb, {
            auditId: priceRes.auditId,
            alertId: c.alert_id,
          }),
        );
      }
      return { outcome: "failed", reason: `executor outcome: ${priceRes.outcome}` };
    }
    notifyPromises.push(
      notifyAutonomousAction(
        { shopId, actionDescription: `Adjusted price for SKU ${c.sku}` },
        merchantEmail,
      ).catch((e) => console.error("[autopilot-notify] unexpected error (adjust_price)", e)),
    );
    return { outcome: "acted", reason: triggerReason };
  }

  // Campaign-scoped remediation moves: reallocate_spend_sku, or a plain cut via
  // pause/reduce. These need a campaign — either the candidate's own or the
  // enriched move target's dedicated campaign; without either, block (rule 12 —
  // the engine should not have offered an executable campaign move with no campaign).
  if (!remCampaignId) {
    console.info(`[autopilot] remediation block on alert ${c.alert_id}: ${move.executor} needs a campaign`);
    return { outcome: "blocked", reason: `remediation: ${move.executor} needs a campaign` };
  }

  // SKU budget shift: route to the Phase-3 SKU gateway. It re-runs
  // enrichRemediation server-side to re-resolve the loser→winner pair from the
  // trusted alert (it does NOT trust client-supplied campaign ids), then
  // delegates to the shipped executeReallocation. Autopilot passes only the
  // alert id + idempotency key + reason; the enriched `target` we read above is
  // used solely to confirm executor === "reallocate_spend_sku" before routing.
  if (move.executor === "reallocate_spend_sku") {
    const verdict = await checkSkuGuardrails(shopId, { dollarImpactCents }, sb);
    if (!verdict.allowed) {
      console.info(`[autopilot] remediation block on alert ${c.alert_id}: ${verdict.reason}`);
      return { outcome: "blocked", reason: verdict.reason ?? "remediation: blocked by SKU guardrails" };
    }
    const client = calderynClient(shopId);
    const skuReallocRes = await executeReallocateSpendSku({
      client,
      sb,
      shopId,
      alertId: c.alert_id,
      idempotencyKey,
      actor: "autopilot",
      triggerReason: reason,
    });
    // executeReallocateSpendSku RESOLVES with the recorded outcome (it does not
    // throw on a platform failure) — never notify or count a non-landed shift
    // as acted, and record the terminal failure as a beta signal (§7). The
    // pair is calibrated under reallocate_budget (graduationKind).
    if (skuReallocRes.outcome !== "succeeded") {
      if (skuReallocRes.outcome === "failed") {
        notifyPromises.push(
          recordActionFailure(shopId, c.detector_id, graduationKind, sb, {
            auditId: skuReallocRes.auditId,
            alertId: c.alert_id,
          }),
        );
      }
      return { outcome: "failed", reason: `executor outcome: ${skuReallocRes.outcome}` };
    }
    // I7: every autonomous action notifies the merchant at execution time.
    notifyPromises.push(
      notifyAutonomousAction(
        { shopId, actionDescription: `Shifted ad spend${c.sku ? ` for SKU ${c.sku}` : ""} (campaign ${remCampaignId})` },
        merchantEmail,
      ).catch((e) => console.error("[autopilot-notify] unexpected error (reallocate_spend_sku)", e)),
    );
    return { outcome: "acted", reason };
  }

  // Plain cut: pause_campaign / reduce_campaign_budget through the existing
  // campaign executor seam executeAction(shopId, ExecuteInput, sb) + the
  // campaign guard. triggerReason flows through ExecuteInput.triggerReason.
  if (move.executor === "pause_campaign" || move.executor === "reduce_campaign_budget") {
    // Non-null campaign target captured so it survives the awaits below
    // (guarded above). Spend/budget were re-derived when the target is the
    // resolved dedicated campaign rather than the candidate's own.
    const campaignId: string = remCampaignId;
    const currentBudgetCents = remCampaignBudgetCents;
    let newBudgetCents =
      move.executor === "reduce_campaign_budget" && currentBudgetCents != null
        ? // Mirror DEFAULT_MAX_CUT_PCT (guard enforces the live value), scaled by
          // the merchant's learned sizing restraint — the override only ever
          // makes the cut smaller.
          Math.round(currentBudgetCents * (1 - 0.5 * remediationMuOverride))
        : undefined;
    if (move.executor === "reduce_campaign_budget" && !newBudgetCents) {
      console.info(`[autopilot] remediation block on alert ${c.alert_id}: no current budget to cut`);
      return { outcome: "blocked", reason: "remediation: no current budget to cut" };
    }
    // pair_dollar_cap clamp (learned rule): the cut may not exceed the merchant's
    // cap — raise the target budget so (current - new) <= cap. Same clamp as the
    // legacy reduce path; never enlarges the cut.
    if (
      move.executor === "reduce_campaign_budget" &&
      currentBudgetCents != null &&
      newBudgetCents !== undefined &&
      remediationCappedDollarCents !== undefined
    ) {
      newBudgetCents = Math.max(newBudgetCents, currentBudgetCents - remediationCappedDollarCents);
      console.info(
        `[autopilot] pair_dollar_cap clamped remediation reduce for ${campaignId}: newBudget=${newBudgetCents}c (cap=${remediationCappedDollarCents}c)`,
      );
    }
    // I1 + I2: autonomous call — bypass forced OFF regardless of the DB setting,
    // null daily action cap treated as 5, and the aggregate daily-dollar ceiling
    // enforced. Same flags as every legacy autonomous checkGuardrails call.
    const verdict = await checkGuardrails(
      shopId,
      {
        kind: move.executor,
        campaignId,
        dollarImpactCents,
        campaignSpendCents: remCampaignSpendCents,
        currentBudgetCents: currentBudgetCents ?? undefined,
        newBudgetCents,
      },
      sb,
      { forceBypassOff: true, autonomous: true },
    );
    if (!verdict.allowed) {
      console.info(`[autopilot] remediation block on alert ${c.alert_id}: ${verdict.reason}`);
      return { outcome: "blocked", reason: verdict.reason ?? "remediation: blocked by guardrails" };
    }
    // I4: freshness + live precondition re-check — the campaign must still be
    // active (pause) / at the snapshot budget (reduce) and its sync facts fresh.
    // Fail-safe: any doubt skips, the alert stays open for the merchant.
    const precheck = await preconditionFresh({
      kind: move.executor,
      candidate: { ...c, campaign_id: campaignId, daily_budget_cents: currentBudgetCents },
      sb,
      nowMs: Date.now(),
    });
    if (!precheck.ok) {
      console.info(
        `[autopilot] remediation precondition re-check failed on alert ${c.alert_id}: ${precheck.reason}`,
      );
      return { outcome: "skipped", reason: precheck.reason ?? "precondition_failed" };
    }
    const res = await executeAction(
      shopId,
      {
        alertId: c.alert_id,
        kind: move.executor,
        campaignId,
        idempotencyKey,
        dailyBudgetCents: newBudgetCents,
        actor: "autopilot",
        triggerReason: reason,
      },
      sb,
    );
    // executeAction reports failure via outcome (it does not throw for platform
    // errors) — a non-landed action must not be counted or celebrated as acted.
    // Terminal failure is a negative calibration signal (spec §7); retrying is
    // transient and records nothing yet.
    if (res.outcome !== "succeeded") {
      if (res.outcome === "failed") {
        notifyPromises.push(
          recordActionFailure(shopId, c.detector_id, graduationKind, sb, {
            auditId: res.id,
            alertId: c.alert_id,
          }),
        );
      }
      return { outcome: "failed", reason: `executor outcome: ${res.outcome}` };
    }
    // I7: every autonomous action notifies the merchant at execution time.
    const actionLabel =
      move.executor === "pause_campaign" ? "Paused campaign" : "Reduced budget for campaign";
    notifyPromises.push(
      notifyAutonomousAction(
        { shopId, actionDescription: `${actionLabel} ${campaignId}` },
        merchantEmail,
      ).catch((e) => console.error("[autopilot-notify] unexpected error (remediation pause/reduce)", e)),
    );
    return { outcome: "acted", reason };
  }

  // Unknown executor union member — fail visibly rather than silently dropping.
  console.warn(`[autopilot] remediation skip on alert ${c.alert_id}: unhandled executor ${move.executor}`);
  return { outcome: "skipped", reason: `remediation: unhandled executor ${move.executor}` };
}

/** Try to autonomously relocate inventory for an inventory-relocation alert.
 *  reallocate_inventory is NOT a remediation MoveKind and its detectors are not
 *  product-economics, so they never reach tryRemediation. This dedicated helper
 *  mirrors tryRemediation's guard→execute→notify→decide shape for the
 *  executeInventoryAlertAction seam. Returns "fell_through" for any non-inventory
 *  detector so the existing remediation/legacy paths still run unchanged. */
async function tryInventoryRelocation(
  shopId: string,
  c: Candidate,
  sb: SupabaseClient,
  merchantEmail: string | null,
  notifyPromises: Promise<void>[],
): Promise<RemediationResult> {
  if (!INVENTORY_RELOCATION_DETECTORS.has(c.detector_id as DetectorId)) {
    return { outcome: "fell_through", reason: "not an inventory-relocation detector" };
  }

  // Concrete transfer plan from the alert's own evidence (never the request).
  const plan = transferPlanFromEvidence(c.evidence ?? {});
  // sku_stockout_vs_spend ALSO has a legacy pause_campaign autopilot path (its
  // own no-brainer gate) and never carries a transfer plan — for it, FALL
  // THROUGH before any other gate so that pause autonomy is preserved (one
  // decision per alert: pause OR relocate, never both).
  if (!plan && c.detector_id === "sku_stockout_vs_spend") {
    return { outcome: "fell_through", reason: "reallocate_inventory: no transfer plan (defer to pause path)" };
  }
  // A weather_demand alert is EITHER a budget move (campaign-scoped: has a
  // campaign_id, no sku_id, no transfer plan) OR an inventory move. A budget one
  // is not an inventory candidate at all — fall through (autonomous ad
  // reallocation is a separate, deferred path) rather than block every tick on
  // "missing transfer evidence" once the inventory pair graduates.
  if (!plan && c.detector_id === "weather_demand" && !c.sku_id) {
    return { outcome: "fell_through", reason: "weather_demand budget alert: not an inventory move" };
  }

  // Graduation gate (same safety model as every other autonomous path). Keyed on
  // the executor kind reallocate_inventory. isGraduated is fail-safe (false on any
  // read error), so a DB hiccup can never grant autonomy. NOT graduated → skip
  // (bucketed as skippedMoves, not a guardrail block) and resolve the candidate.
  // Checked BEFORE evidence validation: a pair that could not act anyway must
  // not flood the summary's blocked histogram with evidence-shape noise every
  // tick — "invalid inventory evidence" is only surfaced (and only actionable)
  // once the pair is actually enabled to act.
  if (!(await isGraduated(shopId, c.detector_id, "reallocate_inventory", sb))) {
    console.info(
      `[autopilot] inventory relocation skip on alert ${c.alert_id}: pair (${c.detector_id}/reallocate_inventory) not graduated`,
    );
    return { outcome: "skipped", reason: "remediation pair not graduated" };
  }

  if (!plan) {
    // A graduated pair with unexecutable evidence is a real, actionable data
    // gap — block so the alert stays open for the merchant (rule 12).
    console.info(`[autopilot] inventory relocation block on alert ${c.alert_id}: invalid inventory evidence`);
    return { outcome: "blocked", reason: "reallocate_inventory: invalid inventory evidence" };
  }

  // DOLLAR/CENTS boundary: c.dollar_impact from v_autopilot_candidates is in
  // DOLLARS — convert to cents for the guardrail check. (executeInventoryAlertAction
  // reads alert.dollar_impact already in CENTS via the DTO, so it does NOT convert;
  // keep the two boundaries consistent and do NOT double-convert here.)
  const dollarImpactCents = Math.round(Number(c.dollar_impact) * 100);
  const inventoryUnitsMoved = Math.abs(plan.delta);

  // Learned-rule enforcement: the merchant's calibration_rule rows bind this
  // path too (blackout hours / min spend / dollar cap). reallocate_inventory
  // cannot be partially applied, so a dollar cap vetoes rather than downsizes.
  // Fail-safe: unloadable rules veto.
  {
    const nowUtc = new Date();
    const ruleVerdict = await loadAndApplyRules(
      shopId,
      c.detector_id,
      "reallocate_inventory",
      {
        dollarImpactCents,
        campaignSpendCents: c.campaign_spend_cents ?? 0,
        nowUtcHour: nowUtc.getUTCHours(),
        nowIso: nowUtc.toISOString(),
      },
      sb,
    );
    if (ruleVerdict.veto) {
      console.info(
        `[autopilot] inventory relocation rule veto on alert ${c.alert_id} (${c.detector_id}/reallocate_inventory): ${ruleVerdict.veto}`,
      );
      return { outcome: "skipped", reason: `rule: ${ruleVerdict.veto}` };
    }
  }
  const verdict = await checkPriceInventoryGuardrails(
    shopId,
    { kind: "reallocate_inventory", dollarImpactCents, inventoryUnitsMoved },
    sb,
  );
  if (!verdict.allowed) {
    // Over cap (or another guardrail): do NOT execute, do NOT acknowledge — the
    // alert stays open for merchant approval (§2.4).
    console.info(`[autopilot] inventory relocation block on alert ${c.alert_id}: ${verdict.reason}`);
    return { outcome: "blocked", reason: verdict.reason ?? "reallocate_inventory: blocked by guardrails" };
  }

  const client = calderynClient(shopId);
  const { admin } = await (await import("~/shopify.server")).unauthenticated.admin(shopId);
  const triggerReason = autopilotReason("Auto move inventory", c.detector_id, c.dollar_impact);
  // The executor re-derives the transfer plan + sku_id from the alert. It
  // throws on pre-audit faults, but a platform failure it recorded RESOLVES
  // with { outcome } — never notify or count a non-landed stock move as acted,
  // and record the terminal failure as a beta signal (§7).
  const invRes = await executeInventoryAlertAction({
    client,
    admin,
    sb,
    shopId,
    alertId: c.alert_id,
    kind: "reallocate_inventory",
    idempotencyKey: `autopilot:${c.alert_id}:reallocate_inventory`,
    actor: "autopilot",
    triggerReason,
  });
  if (invRes.outcome !== "succeeded") {
    if (invRes.outcome === "failed") {
      notifyPromises.push(
        recordActionFailure(shopId, c.detector_id, "reallocate_inventory", sb, {
          auditId: invRes.auditId,
          alertId: c.alert_id,
        }),
      );
    }
    return { outcome: "failed", reason: `executor outcome: ${invRes.outcome}` };
  }
  notifyPromises.push(
    notifyAutonomousAction(
      { shopId, actionDescription: `Moved inventory${c.sku ? ` for SKU ${c.sku}` : ""}` },
      merchantEmail,
    ).catch((e) => console.error("[autopilot-notify] unexpected error (reallocate_inventory)", e)),
  );
  return { outcome: "acted", reason: triggerReason };
}

/** Try to autonomously execute the ad-budget reallocation a weather cron
 *  proposed. weather_demand alerts are EITHER a campaign-scoped budget move
 *  (a reallocationPlan carried verbatim in evidence) OR an inventory move —
 *  tryInventoryRelocation above handles the inventory case and falls through
 *  for the budget case, which lands here. Mirrors tryInventoryRelocation's
 *  guard→graduation→guardrail→execute→notify→decide shape, and reuses the
 *  SAME checkGuardrails/executeReallocation call shape as the autonomous
 *  reallocation nested in the legacy reduce_campaign_budget branch. Returns
 *  "fell_through" for any non-weather detector, or a weather alert whose
 *  evidence carries no budget plan, so the caller can defer to the rest of
 *  the chain. */
async function tryWeatherBudgetReallocation(
  shopId: string,
  c: Candidate,
  sb: SupabaseClient,
  merchantEmail: string | null,
  notifyPromises: Promise<void>[],
): Promise<RemediationResult> {
  if (c.detector_id !== "weather_demand") {
    return { outcome: "fell_through", reason: "not a weather-budget detector" };
  }

  // Concrete reallocation plan from the alert's own evidence (never the
  // request) — the weather cron carries source/dest/amount verbatim.
  const plan = reallocationPlanFromEvidence(c.evidence ?? {});
  // An inventory-shaped weather alert (sku_id, transfer plan) has no budget
  // plan — that case is already handled by tryInventoryRelocation above.
  // Defer rather than block: "no budget plan" is not an actionable data gap
  // for this alert.
  if (!plan) {
    return { outcome: "fell_through", reason: "weather_demand: no budget plan (defer)" };
  }

  // Graduation gate (same safety model as every other autonomous path).
  // isGraduated is fail-safe (false on any read error), so a DB hiccup can
  // never grant autonomy.
  if (!(await isGraduated(shopId, c.detector_id, "reallocate_budget", sb))) {
    console.info(
      `[autopilot] weather budget reallocation skip on alert ${c.alert_id}: pair (${c.detector_id}/reallocate_budget) not graduated`,
    );
    return { outcome: "skipped", reason: "weather budget pair not graduated" };
  }

  // The budget alert's entity_ref.campaign_id IS the source campaign, so the
  // candidate row's own daily_budget_cents/campaign_spend_cents describe the
  // source campaign's current budget and 7d spend.
  const currentBudgetCents = c.daily_budget_cents ?? 0;
  // A source with no positive budget can't be cut. The candidate view coalesces a
  // null budget to 0; without this guard, currentBudgetCents=0 would skip the
  // maxBudgetCutPct check and yield a negative newBudgetCents. Match the legacy
  // reduce-branch's budget>0 precondition — skip (fail safe), never reallocate.
  if (currentBudgetCents <= 0) {
    return { outcome: "skipped", reason: "source campaign has no budget to reallocate" };
  }
  const newBudgetCents = currentBudgetCents - plan.amountCents;
  const verdict = await checkGuardrails(
    shopId,
    {
      kind: "reallocate_budget",
      campaignId: plan.sourceCampaignId,
      destCampaignId: plan.destCampaignId,
      dollarImpactCents: plan.amountCents,
      campaignSpendCents: c.campaign_spend_cents ?? 0,
      currentBudgetCents,
      newBudgetCents,
    },
    sb,
    { forceBypassOff: true, autonomous: true },
  );
  if (!verdict.allowed) {
    console.info(`[autopilot] weather budget reallocation block on alert ${c.alert_id}: ${verdict.reason}`);
    return { outcome: "blocked", reason: verdict.reason ?? "blocked by guardrails" };
  }

  const triggerReason = autopilotReason("Auto reallocate budget", c.detector_id, c.dollar_impact);
  const res = await executeReallocation(
    shopId,
    {
      alertId: c.alert_id,
      sourceCampaignId: plan.sourceCampaignId,
      destCampaignId: plan.destCampaignId,
      amountCents: plan.amountCents,
      idempotencyKey: `autopilot:${c.alert_id}:reallocate_budget`,
      actor: "autopilot",
      triggerReason,
    },
    sb,
  );
  // Mirror tryInventoryRelocation exactly: only a landed "succeeded" counts as
  // acted. "retrying" (transient, parked for the retry cron) and "failed"
  // (permanent) both resolve here as "failed" — never notify or count a
  // non-landed budget move as acted — but only a terminal "failed" is a
  // negative calibration signal (a "retrying" outcome may still land later).
  if (res.outcome !== "succeeded") {
    if (res.outcome === "failed") {
      notifyPromises.push(
        recordActionFailure(shopId, c.detector_id, "reallocate_budget", sb, {
          auditId: res.id,
          alertId: c.alert_id,
        }),
      );
    }
    return { outcome: "failed", reason: `executor outcome: ${res.outcome}` };
  }
  notifyPromises.push(
    notifyAutonomousAction(
      { shopId, actionDescription: `Reallocated budget from campaign ${plan.sourceCampaignId}` },
      merchantEmail,
    ).catch((e) => console.error("[autopilot-notify] unexpected error (weather reallocate_budget)", e)),
  );
  return { outcome: "acted", reason: triggerReason };
}

function autopilotReason(
  verb: string,
  detectorId: string,
  dollarImpact: number,
): string {
  const label =
    DETECTOR_LABELS[detectorId as keyof typeof DETECTOR_LABELS] ?? detectorId;
  const stake = Math.round(Number(dollarImpact) || 0).toLocaleString("en-US");
  return `${verb}: "${label}" — $${stake} at stake, within guardrails`;
}

export async function runAutopilotForShop(
  shopId: string,
  sb: SupabaseClient,
): Promise<AutopilotSummary> {
  const { data: cfg, error: cErr } = await sb
    .from("guardrail_config")
    .select(
      "autopilot_enabled, autopilot_max_budget_cut_pct, autopilot_max_budget_increase_pct, autopilot_max_daily_budget_cents",
    )
    .eq("shop_id", shopId)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!cfg || !cfg.autopilot_enabled)
    return {
      skipped: true,
      acted: 0,
      blocked: 0,
      skippedMoves: 0,
      failed: 0,
      considered: 0,
      blockedReasons: {},
      decisions: [],
    };

  // I6: Per-shop concurrency lock — prevents overlapping cron ticks from
  // double-acting on the same shop. Fail-safe: if the lock is NOT acquired
  // (concurrent tick holds it, OR the DB call errored), we skip this tick
  // rather than running unlocked and risking double-action.
  //
  // Mechanism: plain INSERT via supabase-js. The shop_id PK unique constraint
  // means exactly one concurrent tick wins; the loser receives a Postgres 23505
  // unique-violation error (not a silent 0-row result), which we treat as
  // "lock held — skip". TTL-row (not pg_try_advisory_lock) because Supabase
  // uses PgBouncer in Transaction mode — advisory locks are session-scoped and
  // are immediately released when the connection returns to the pool.
  const lock = await acquireAutopilotLock(shopId, sb);
  if (!lock.acquired) {
    console.info(`[autopilot] skipping shop ${shopId}: ${lock.reason ?? "lock not acquired"}`);
    return {
      skipped: true,
      acted: 0,
      blocked: 0,
      skippedMoves: 0,
      failed: 0,
      considered: 0,
      blockedReasons: {},
      decisions: [],
    };
  }

  // I6: Wrap the entire tick in try/finally so the lock is ALWAYS released,
  // even if a DB error or throw escapes the per-candidate catch blocks below.
  try {

  // Load merchant contact email for autonomous-action notifications (best-effort;
  // a missing email row just means no notification fires — never a thrown error).
  // Email lives in shopify_sessions (online sessions carry the account-owner email);
  // join via shops.shop_domain → shopify_sessions.shop, preferring online sessions.
  let merchantEmail: string | null = null;
  try {
    const { data: shopRow } = await sb
      .from("shops")
      .select("shop_domain")
      .eq("id", shopId)
      .maybeSingle();
    const shopDomain = (shopRow as { shop_domain?: string | null } | null)?.shop_domain ?? null;
    if (shopDomain) {
      const { data: sessions } = await sb
        .from("shopify_sessions")
        .select("email, isOnline, accountOwner")
        .eq("shop", shopDomain)
        .not("email", "is", null);
      // Prefer: online + accountOwner first, then online, then offline accountOwner, then any.
      const rows = (sessions ?? []) as Array<{
        email: string | null;
        isOnline: boolean;
        accountOwner: boolean;
      }>;
      const best =
        rows.find((r) => r.isOnline && r.accountOwner) ??
        rows.find((r) => r.isOnline) ??
        rows.find((r) => r.accountOwner) ??
        rows[0] ??
        null;
      merchantEmail = best?.email ?? null;
    }
  } catch {
    // Non-fatal: if we can't read the session email, we just skip the notification.
  }

  const maxCutPct = Number(cfg.autopilot_max_budget_cut_pct ?? DEFAULT_MAX_CUT_PCT);
  const maxIncreasePct = Number(cfg.autopilot_max_budget_increase_pct ?? DEFAULT_MAX_INCREASE_PCT);
  const maxDailyBudgetCents =
    cfg.autopilot_max_daily_budget_cents == null
      ? null
      : Number(cfg.autopilot_max_daily_budget_cents);

  const { data: rows, error: aErr } = await sb
    .from("v_autopilot_candidates")
    .select(
      "alert_id, detector_id, dollar_impact, campaign_id, campaign_spend_cents, daily_budget_cents, evidence, sku, sku_id",
    )
    .eq("shop_id", shopId)
    .order("dollar_impact", { ascending: false });
  if (aErr) throw aErr;
  const candidates = (rows ?? []) as Candidate[];

  // D6: shop-scoped ad_tax_overload alerts carry no campaign_id, so they never
  // appear in v_autopilot_candidates. Resolve a campaign target for them and
  // feed them through the same defensive loop. (SKU-scoped negative_unit_economics
  // targeting is deferred — see spec §8.)
  const { data: scopedRows } = await sb
    .from("alerts")
    .select("id, detector_id, dollar_impact, entity_ref")
    .eq("shop_id", shopId)
    .eq("status", "open")
    .in("detector_id", ["ad_tax_overload"]);

  // Hoisted pool: serves BOTH the scoped-candidate resolver and every
  // reallocation decision in the loop. Load it if either needs it.
  const gradedPool =
    candidates.some((c) => BUDGET_DETECTORS.has(c.detector_id)) || (scopedRows ?? []).length > 0
      ? await loadReallocationCandidates(shopId, sb)
      : [];

  const scoped = await resolveScopedCandidates(shopId, (scopedRows ?? []) as never, gradedPool, sb);

  // Merge per alert_id so EACH alert is exactly one candidate (rule 12: no
  // double-processing of live money). A campaign-less ad_tax_overload alert now
  // surfaces in BOTH sources: the view row (LEFT JOIN) carries evidence/sku with
  // a null campaign_id; the scoped resolver carries an attribution-resolved
  // campaign_id + budget but no evidence. Without this, that one alert would
  // appear twice — tryRemediation could act on one copy while the other
  // fell_through to a legacy reduce, and the campaign-less view copy would emit a
  // spurious "requires a campaign_id" block, corrupting the audit.
  //
  // For each view candidate whose campaign_id is null with a matching scoped
  // entry, backfill the resolved campaign_id + the budget/spend fields the legacy
  // path reads (daily_budget_cents → currentBudgetCents, campaign_spend_cents →
  // the guardrail check). Then append only scoped entries whose alert_id is not
  // already covered by a view candidate. Result: one candidate per alert_id,
  // carrying BOTH evidence (for tryRemediation) AND a campaign target (for a
  // fell-through legacy reduce/reallocate). dollar_impact ordering is preserved:
  // view candidates keep their position; scoped-only candidates append after.
  const scopedByAlert = new Map(scoped.map((s) => [s.alert_id, s]));
  const seenAlertIds = new Set(candidates.map((c) => c.alert_id));
  const mergedViewCandidates = candidates.map((c) => {
    if (c.campaign_id != null) return c;
    const s = scopedByAlert.get(c.alert_id);
    if (!s) return c;
    return {
      ...c,
      campaign_id: s.campaign_id,
      daily_budget_cents: s.daily_budget_cents,
      campaign_spend_cents: s.campaign_spend_cents,
    };
  });
  const scopedOnly = scoped.filter((s) => !seenAlertIds.has(s.alert_id));
  const allCandidates = [...mergedViewCandidates, ...scopedOnly];

  // Defensive actions (pause/reduce/reallocate) take priority over resume and
  // scale-ups so loss-prevention is never starved of the daily action cap by a
  // bigger-dollar opportunity. Resume restarts spend, so it ranks ahead of
  // offensive scale-ups but behind loss-prevention. Each subgroup keeps its
  // dollar_impact order.
  const ordered = [
    ...allCandidates.filter(
      (c) => !SCALE_DETECTORS.has(c.detector_id) && !RESUME_DETECTORS.has(c.detector_id),
    ),
    ...allCandidates.filter((c) => RESUME_DETECTORS.has(c.detector_id)),
    ...allCandidates.filter((c) => SCALE_DETECTORS.has(c.detector_id)),
  ];

  let acted = 0;
  let blocked = 0;
  // Remediation recommendations that were advisory/non-executable and not acted
  // on (distinct from `blocked`, a guardrail/cap/precondition refusal).
  let skippedMoves = 0;
  let failed = 0;
  const decisions: AutopilotDecision[] = [];
  // Collect notify promises so they are awaited (via Promise.allSettled) before
  // runAutopilotForShop returns. This prevents Vercel cron from abandoning them
  // mid-flight when the response is sent. allSettled means a delivery failure
  // never fails the run or affects the summary.
  const notifyPromises: Promise<void>[] = [];
  // reason -> count for every candidate that landed in the `blocked` counter
  // (guardrail blocks AND pre-flight skips), so the histogram explains the
  // FULL blocked total and `sum(blockedReasons) === blocked` holds.
  const blockedReasons: Record<string, number> = {};
  // Record one structured decision per candidate so the run is auditable even
  // when nothing acts (rule 12). The acted/blocked/failed COUNTERS keep their
  // existing buckets (a pre-flight refusal counts as `blocked`); the decision's
  // `outcome` carries the finer label (a pre-flight refusal is `skipped`, as
  // distinct from a guardrail `blocked`).
  const decide = (
    c: Candidate,
    intendedKind: ExecutableKind | null,
    outcome: AutopilotOutcome,
    reason: string,
    bucket: "acted" | "blocked" | "failed" | "none" = outcome === "skipped" ? "blocked" : outcome,
  ) => {
    if (bucket === "acted") acted += 1;
    else if (bucket === "blocked") {
      blocked += 1;
      blockedReasons[reason] = (blockedReasons[reason] ?? 0) + 1;
    } else if (bucket === "failed") failed += 1;
    decisions.push({
      alertId: c.alert_id,
      // SKU-scoped candidates that acted on a resolved dedicated campaign
      // stash it so the audited decision names the campaign that was actually
      // touched (matching action_audit + the merchant notification), not null.
      campaignId:
        (c as Candidate & { _resolvedCampaignId?: string })._resolvedCampaignId ?? c.campaign_id,
      detectorId: c.detector_id,
      intendedKind,
      outcome,
      reason,
    });
  };
  // Bucket an executor's REAL outcome: only a landed "succeeded" is an action
  // taken. "failed"/"retrying" (platform error, or parked for the retry cron)
  // did NOT change a budget this run, so they must not inflate `acted`.
  // A terminal "failed" is also a negative calibration signal (spec §7: the
  // pair proposed an action the platform could not land → beta +1); "retrying"
  // is transient and records nothing yet. Keyed on the audit id so an
  // idempotency REPLAY of the same failed audit on a later tick never
  // double-bumps beta. Collected into notifyPromises so the write is awaited
  // before the serverless response flushes.
  const record = (c: Candidate, kind: ExecutableKind, res: ExecutedAudit) => {
    if (res.outcome === "succeeded") {
      decide(c, kind, "acted", kind);
      return;
    }
    decide(c, kind, "failed", `executor outcome: ${res.outcome}`);
    if (res.outcome === "failed") {
      notifyPromises.push(
        recordActionFailure(shopId, c.detector_id, kind, sb, {
          auditId: res.id,
          alertId: c.alert_id,
        }),
      );
    }
  };
  for (const c of ordered) {
    // Isolate each candidate. The guardrail read and both executors THROW on
    // per-campaign faults — an ownership mismatch, a DB hiccup, or a
    // stale-budget reallocation (live source budget dropped below the view
    // snapshot, so amount >= source budget). An uncaught throw here would
    // abort loss-prevention for the shop's OTHER money-losing campaigns, so
    // count it failed and keep draining.
    try {
      // FIRST branch: inventory-relocation detectors route to the dedicated
      // executeInventoryAlertAction seam (a physical stock move, not a campaign
      // or product-econ remediation). A candidate that ACTS / BLOCKS / SKIPS here
      // is fully resolved (`continue`) so it can never also reach tryRemediation
      // or the legacy path — one decision per alert, no double execution. Only a
      // "fell_through" (a non-inventory detector, or a sku_stockout_vs_spend with
      // no transfer plan that should defer to its pause path) proceeds below.
      const relocation = await tryInventoryRelocation(shopId, c, sb, merchantEmail, notifyPromises);
      if (relocation.outcome === "acted") {
        decide(c, null, "acted", relocation.reason);
        continue;
      }
      if (relocation.outcome === "blocked") {
        decide(c, null, "blocked", relocation.reason);
        continue;
      }
      if (relocation.outcome === "skipped") {
        skippedMoves += 1;
        decide(c, null, "skipped", relocation.reason, "none");
        continue;
      }
      if (relocation.outcome === "failed") {
        decide(c, null, "failed", relocation.reason);
        continue;
      }
      // relocation.outcome === "fell_through": not an inventory move — proceed.

      // 1.5th branch: a weather-driven budget alert (weather_demand carrying a
      // reallocationPlan) routes to its own dedicated autonomous-reallocation
      // seam, mirroring tryInventoryRelocation's shape and reusing the SAME
      // checkGuardrails/executeReallocation call shape as the legacy
      // reduce_campaign_budget reallocation sub-branch below. A candidate that
      // ACTS / BLOCKS / SKIPS / FAILS here is fully resolved (`continue`) so it
      // can never also reach tryRemediation or the legacy path — one decision
      // per alert. Only a "fell_through" (a non-weather detector, or a weather
      // alert with no budget plan — e.g. the inventory-shaped case
      // tryInventoryRelocation already handled above) proceeds below.
      const weatherRealloc = await tryWeatherBudgetReallocation(shopId, c, sb, merchantEmail, notifyPromises);
      if (weatherRealloc.outcome === "acted") {
        decide(c, null, "acted", weatherRealloc.reason);
        continue;
      }
      if (weatherRealloc.outcome === "blocked") {
        decide(c, null, "blocked", weatherRealloc.reason);
        continue;
      }
      if (weatherRealloc.outcome === "skipped") {
        skippedMoves += 1;
        decide(c, null, "skipped", weatherRealloc.reason, "none");
        continue;
      }
      if (weatherRealloc.outcome === "failed") {
        decide(c, null, "failed", weatherRealloc.reason);
        continue;
      }
      // weatherRealloc.outcome === "fell_through": not a weather-budget move —
      // proceed.

      // SECOND branch: route product-economics detectors through the engine's
      // recommended remediation move (discontinue / reallocate / cut a SKU or
      // campaign) within its OWN guardrails. tryRemediation bypasses
      // getActionPolicy on purpose — these are SKU/structural moves, not the
      // campaign-budget multipliers the learned dial scales. A candidate that
      // ACTS or BLOCKS here is fully resolved (`continue`) so it can never also
      // hit the legacy path below — no double execution on live money.
      const rem = await tryRemediation(shopId, c, sb, merchantEmail, notifyPromises);
      if (rem.outcome === "acted") {
        decide(c, null, "acted", rem.reason);
        continue;
      }
      if (rem.outcome === "blocked") {
        decide(c, null, "blocked", rem.reason);
        continue;
      }
      if (rem.outcome === "skipped") {
        // A non-executing remediation outcome that is neither an act nor a
        // guardrail block: an advisory/non-executable recommendation, an
        // un-graduated remediation pair (calibration gate), or an unhandled
        // executor. It is fully resolved (no fall-through — the legacy path is
        // graduation-gated too and would also skip, so falling through would
        // double-evaluate the alert). Count it separately and record a decision
        // (rule 12), but keep it OUT of the `blocked` counter/histogram (bucket
        // "none").
        skippedMoves += 1;
        decide(c, null, "skipped", rem.reason, "none");
        continue;
      }
      if (rem.outcome === "failed") {
        // The remediation executor was called but the action did not land
        // (platform error / parked as retrying). Fully resolved — never fall
        // through to the legacy path, which would double-evaluate the alert.
        decide(c, null, "failed", rem.reason);
        continue;
      }
      // rem.outcome === "fell_through": defer to the legacy campaign logic so an
      // overlapping detector (e.g. ad_tax_overload) still reduces/reallocates.

      let kind: ExecutableKind | null = null;
      if (PAUSE_DETECTORS.has(c.detector_id)) kind = "pause_campaign";
      else if (BUDGET_DETECTORS.has(c.detector_id)) kind = "reduce_campaign_budget";
      else if (SCALE_DETECTORS.has(c.detector_id)) kind = "increase_campaign_budget";
      else if (RESUME_DETECTORS.has(c.detector_id)) kind = "resume_campaign";
      if (!kind) {
        decide(c, null, "skipped", "detector not actionable by autopilot", "none");
        continue;
      }

      // Legacy campaign logic requires a non-null campaign_id. A fell-through
      // candidate without one (data gap in the view) is blocked, not silently
      // dropped (rule 12). Checked before the graduation gate because it is a
      // structural precondition of the legacy executor seam.
      // SKU-only candidates (e.g. a stockout alert the engine could not key to
      // a campaign) get one trusted resolution attempt before the structural
      // block: the SKU's dedicated mutable campaign from
      // v_sku_remediation_inputs (>= 70% of the campaign's attributed revenue,
      // active, budgeted). Pause-only — budget cuts/increases are never taken
      // against an inferred campaign. Spend/budget are re-derived for the
      // resolved campaign so the min-spend guardrail and the freshness
      // snapshot stay honest. Fail-closed: no dedicated campaign (or any read
      // error) keeps the existing blocked-with-reason behavior, so the alert
      // stays queued for the merchant (rule 12).
      let resolvedCampaignId = c.campaign_id;
      let currentBudgetCents = c.daily_budget_cents ?? null;
      let campaignSpendCents = c.campaign_spend_cents;
      // Scoped ad_tax_overload candidates lack sku fields — narrow like the
      // resume block does; undefined refs simply skip the resolution attempt.
      const skuRef = c as Candidate;
      if (!resolvedCampaignId && kind === "pause_campaign" && (skuRef.sku_id || skuRef.sku)) {
        const resolved = await resolveDedicatedCampaign(sb, shopId, {
          skuId: skuRef.sku_id,
          sku: skuRef.sku,
        });
        if (resolved) {
          resolvedCampaignId = resolved.campaignId;
          currentBudgetCents = resolved.dailyBudgetCents;
          campaignSpendCents = resolved.spendCents;
          (c as Candidate & { _resolvedCampaignId?: string })._resolvedCampaignId =
            resolved.campaignId;
          console.info(
            `[autopilot] resolved dedicated campaign ${resolved.campaignId} for SKU-scoped alert ${c.alert_id}`,
          );
        }
      }
      if (!resolvedCampaignId) {
        const reason = `${kind} requires a campaign_id`;
        console.info(`[autopilot] blocked legacy action on alert ${c.alert_id}: ${reason}`);
        decide(c, kind, "blocked", reason);
        continue;
      }
      // Non-null campaign_id captured here so it survives the awaits/closures
      // below (TS would otherwise re-widen it back to string | null). The
      // merged Candidate keeps campaign_id nullable for SKU-only economics
      // alerts; the legacy seam — and preconditionFresh's targeting Candidate —
      // require it non-null, which the guard above guarantees.
      const campaignId: string = resolvedCampaignId;

      // Learned pairs must earn graduation; the three shipped no-brainers start
      // unlocked. isGraduated remains fail-safe, so a DB hiccup can never grant
      // autonomy.
      if (!(await isGraduated(shopId, c.detector_id, kind, sb))) {
        decide(c, kind, "skipped", "pair not graduated");
        continue;
      }

      // Rule enforcement (Slice 5 Task 5): apply the merchant's learned
      // calibration_rule rows for this (detector, action) pair BEFORE any
      // execute path is reached. This single check dominates all execute paths
      // for the three graduatable kinds (pause/reduce/increase).
      // Fail-safe: a thrown load returns { veto: "rules unavailable" } —
      // we must never execute when we can't verify the merchant's restrictions.
      {
        const nowUtc = new Date();
        const ruleVerdict = await loadAndApplyRules(
          shopId,
          c.detector_id,
          kind,
          {
            dollarImpactCents: Math.round(Number(c.dollar_impact) * 100),
            campaignSpendCents,
            nowUtcHour: nowUtc.getUTCHours(),
            nowIso: nowUtc.toISOString(),
          },
          sb,
        );
        if (ruleVerdict.veto) {
          console.info(`[autopilot] rule veto for ${campaignId} (${c.detector_id}/${kind}): ${ruleVerdict.veto}`);
          decide(c, kind, "skipped", `rule: ${ruleVerdict.veto}`);
          continue;
        }
        // pair_dollar_cap on reduce: cap the cut amount by storing into a
        // candidate-local that the reduce path reads below.
        if (ruleVerdict.cappedDollarCents !== undefined) {
          // Stash the cap so the reduce path clamps newBudgetCents.
          // We piggy-back on the existing Candidate shape via a local variable.
          // The capped amount is resolved after currentBudgetCents is known, below.
          (c as Candidate & { _cappedDollarCents?: number })._cappedDollarCents = ruleVerdict.cappedDollarCents;
        }
        if (ruleVerdict.muOverride !== undefined) {
          // Learned sizing restraint (too_aggressive): consumed below as
          // min(policyMu, muOverride) — it can only shrink a cut/increase.
          (c as Candidate & { _muOverride?: number })._muOverride = ruleVerdict.muOverride;
        }
      }
      const muOverride = (c as Candidate & { _muOverride?: number })._muOverride ?? 1;

      // Slice B: resume a campaign Calderyn auto-paused for a stockout, now that
      // its SKU is restocked. resume_campaign restarts spend, so it clears the
      // same gates as the other autonomous kinds: guardrails (with the PRE-PAUSE
      // spend so the min-spend gate is not defeated by the paused campaign's
      // near-zero recent spend), an I4 freshness re-check (campaign still paused),
      // and the dedicated live restock allowlist (restocked above buffer, still
      // Calderyn-paused). Every check is fail-safe → on any doubt we skip and the
      // alert stays queued for the merchant. Resolved here (continue) — resume
      // never touches the budget logic below.
      if (kind === "resume_campaign") {
        // Resume candidates always come from the view (the merged Candidate with
        // evidence/sku/sku_id); the scoped ad_tax_overload candidates are never a
        // RESUME_DETECTORS id. Narrow to read the view-only fields.
        const cc = c as Candidate;
        const evidence = (cc.evidence ?? null) as Record<string, unknown> | null;
        const prepauseSpendCents = Math.round(Number(evidence?.prepause_spend_7d_usd ?? 0) * 100);
        const bufferUnits = Number(evidence?.buffer_units ?? 0);
        const verdict = await checkGuardrails(
          shopId,
          {
            kind: "resume_campaign",
            campaignId,
            dollarImpactCents: Math.round(Number(c.dollar_impact) * 100),
            // Pre-pause spend, not the paused campaign's near-zero recent spend,
            // so the min-spend guardrail stays meaningful instead of false-blocking.
            campaignSpendCents: Math.max(campaignSpendCents, prepauseSpendCents),
          },
          sb,
          { forceBypassOff: true, autonomous: true },
        );
        if (!verdict.allowed) {
          decide(c, kind, "blocked", verdict.reason ?? "blocked by guardrails");
          continue;
        }
        const precheck = await preconditionFresh({
          kind,
          candidate: { ...c, campaign_id: campaignId },
          sb,
          nowMs: Date.now(),
        });
        if (!precheck.ok) {
          console.info(`[autopilot] resume precondition failed for ${campaignId}: ${precheck.reason}`);
          decide(c, kind, "skipped", precheck.reason ?? "precondition_failed");
          continue;
        }
        const resumeCheck = await stockoutClearedResumeAllowed({
          shopId,
          alert: {
            id: c.alert_id,
            detector_id: c.detector_id,
            entity_ref: {
              campaign_id: campaignId,
              sku_id: cc.sku_id ?? undefined,
              sku: cc.sku ?? undefined,
            },
          },
          bufferUnits,
          sb,
        });
        if (!resumeCheck.ok) {
          console.info(`[autopilot] resume allowlist blocked ${campaignId}: ${resumeCheck.reason}`);
          decide(c, kind, "skipped", resumeCheck.reason ?? "resume_precondition_not_met");
          continue;
        }
        const res = await executeAction(
          shopId,
          {
            alertId: c.alert_id,
            kind: "resume_campaign",
            campaignId,
            idempotencyKey: `autopilot:${c.alert_id}:resume_campaign`,
            actor: "autopilot",
            triggerReason: autopilotReason("Auto-resume", c.detector_id, c.dollar_impact),
          },
          sb,
        );
        record(c, kind, res);
        if (res.outcome === "succeeded") {
          notifyPromises.push(
            notifyAutonomousAction(
              { shopId, actionDescription: `Resumed campaign ${campaignId}` },
              merchantEmail,
            ).catch((e) => console.error("[autopilot-notify] unexpected error (resume)", e)),
          );
        }
        continue;
      }

      if (kind === "increase_campaign_budget") {
        if (!currentBudgetCents) {
          const reason =
            currentBudgetCents == null
              ? "current daily budget missing from sync"
              : "current daily budget is $0";
          console.info(`[autopilot] skipped scale on ${campaignId}: ${reason}`);
          decide(c, kind, "skipped", reason);
          continue;
        }
        const muInc = Math.min(
          (await getActionPolicy(sb, shopId, c.detector_id, "increase_campaign_budget")) ?? 1,
          muOverride,
        );
        let target = Math.round(currentBudgetCents * (1 + (maxIncreasePct * muInc) / 100));
        if (maxDailyBudgetCents != null) target = Math.min(target, maxDailyBudgetCents);
        if (target <= currentBudgetCents) {
          const reason = "already at/above the daily ceiling";
          console.info(`[autopilot] skipped scale on ${campaignId}: ${reason}`);
          decide(c, kind, "skipped", reason);
          continue;
        }
        const verdict = await checkGuardrails(
          shopId,
          {
            kind: "increase_campaign_budget",
            campaignId,
            dollarImpactCents: Math.round(Number(c.dollar_impact) * 100),
            campaignSpendCents,
            currentBudgetCents,
            newBudgetCents: target,
          },
          sb,
          { forceBypassOff: true, autonomous: true },
        );
        if (!verdict.allowed) {
          decide(c, kind, "blocked", verdict.reason ?? "blocked by guardrails");
          continue;
        }
        const res = await executeAction(
          shopId,
          {
            alertId: c.alert_id,
            kind: "increase_campaign_budget",
            campaignId,
            idempotencyKey: `autopilot:${c.alert_id}:increase_campaign_budget`,
            dailyBudgetCents: target,
            actor: "autopilot",
            triggerReason: autopilotReason("Auto scale budget", c.detector_id, c.dollar_impact),
          },
          sb,
        );
        record(c, kind, res);
        if (res.outcome === "succeeded") {
          // Collect for await Promise.allSettled at end of run — prevents serverless abandonment.
          notifyPromises.push(
            notifyAutonomousAction(
              { shopId, actionDescription: `Scaled up campaign budget (campaign ${campaignId})` },
              merchantEmail,
            ).catch((e) => console.error("[autopilot-notify] unexpected error (budget scale)", e)),
          );
        }
        continue;
      }

      // A budget cut needs a known current budget to cut from. executeAction
      // refuses a missing/zero target budget (it would otherwise zero the live
      // campaign) — so count it blocked and keep draining the remaining candidates.
      if (kind === "reduce_campaign_budget" && !currentBudgetCents) {
        // Distinguish "no budget synced" from "budget is $0 on the platform" —
        // both skip, but they have different operator fixes.
        const reason =
          currentBudgetCents == null
            ? "current daily budget missing from sync"
            : "current daily budget is $0 on the platform";
        console.info(`[autopilot] skipped budget cut on ${campaignId}: ${reason}`);
        decide(c, kind, "skipped", reason);
        continue;
      }

      const muCut =
        kind === "reduce_campaign_budget"
          ? Math.min(
              (await getActionPolicy(sb, shopId, c.detector_id, "reduce_campaign_budget")) ?? 1,
              muOverride,
            )
          : 1;
      let newBudgetCents =
        kind === "reduce_campaign_budget" && currentBudgetCents != null
          ? Math.round(currentBudgetCents * (1 - (maxCutPct * muCut) / 100))
          : undefined;

      // pair_dollar_cap clamp for reduce: ensure the cut (currentBudgetCents -
      // newBudgetCents) does not exceed the merchant's dollar cap. The cap was
      // stashed by the rule-enforcement block above. This adjusts the target
      // upward so the cut is smaller — never executes a bigger cut than allowed.
      if (
        kind === "reduce_campaign_budget" &&
        currentBudgetCents != null &&
        newBudgetCents !== undefined
      ) {
        const cappedCents = (c as Candidate & { _cappedDollarCents?: number })._cappedDollarCents;
        if (cappedCents !== undefined) {
          // Clamp: newBudgetCents >= currentBudgetCents - cappedCents
          newBudgetCents = Math.max(newBudgetCents, currentBudgetCents - cappedCents);
          console.info(
            `[autopilot] pair_dollar_cap clamped reduce for ${campaignId}: newBudget=${newBudgetCents}c (cap=${cappedCents}c)`,
          );
        }
      }

      // Same refusal in executeAction: a cut that lands on $0 would zero the
      // live campaign budget (that's a pause, not a reduction) — blocked. Only
      // reachable with maxCutPct near 100, so flag the config loudly.
      if (kind === "reduce_campaign_budget" && !newBudgetCents) {
        const reason = "max_budget_cut_pct computes a $0 target budget";
        console.warn(`[autopilot] skipped budget cut on ${campaignId}: ${reason} (max_budget_cut_pct=${maxCutPct})`);
        decide(c, kind, "skipped", reason);
        continue;
      }

      // Budget detectors: prefer REDIRECTING the cut to a winning campaign on
      // another platform over shrinking total spend. Falls back to the plain
      // reduction below when no destination exists. A guardrail-blocked
      // reallocation does NOT fall through to reduce — same alert, same day,
      // one decision (counted as blocked).
      //
      // Magnitude: reallocation has its OWN learned dial. We recompute the moved
      // amount from `muRealloc` (the trainer's separate reallocate_budget policy)
      // rather than inheriting the reduce dial baked into newBudgetCents — so that
      // model family is actually consumed. If muRealloc zeroes the move, we fall
      // through to a plain reduce so loss-prevention still acts. Dormant-safe: with
      // no model both dials default to 1, so the moved amount equals prior behavior
      // (currentBudgetCents - newBudgetCents). muRealloc ∈ [0,1] keeps the implied
      // cut ≤ maxCutPct, so checkGuardrails (unchanged) still enforces the ceiling.
      //
      // Calibration gate: even though reallocate_budget is now in GRADUATABLE,
      // we independently verify its graduation before entering the reallocation
      // sub-branch. This prevents a graduated reduce_campaign_budget from
      // smuggling in an autonomous reallocation. When not graduated, fall through
      // to the plain reduce path so loss-prevention still acts.
      if (kind === "reduce_campaign_budget" && currentBudgetCents != null && newBudgetCents != null) {
        if (currentBudgetCents - newBudgetCents > 0) {
          const { dest } = pickReallocation(gradedPool, { sourceCampaignId: campaignId });
          if (dest && (await isGraduated(shopId, c.detector_id, "reallocate_budget", sb))) {
            // muOverride was learned on the reduce pair, and it binds here on
            // purpose: a reallocation removes amountCents from the SAME source
            // campaign the merchant said was being cut too aggressively — the
            // restraint governs how much leaves that campaign, whichever
            // executor carries the cut.
            const muRealloc = Math.min(
              (await getActionPolicy(sb, shopId, c.detector_id, "reallocate_budget")) ?? 1,
              muOverride,
            );
            const amountCents = Math.round((currentBudgetCents * maxCutPct * muRealloc) / 100);
            if (amountCents > 0) {
              const reallocSrcBudget = currentBudgetCents - amountCents;
              const verdict = await checkGuardrails(
                shopId,
                {
                  kind: "reallocate_budget",
                  campaignId,
                  destCampaignId: dest.campaignId,
                  dollarImpactCents: amountCents,
                  campaignSpendCents,
                  currentBudgetCents,
                  newBudgetCents: reallocSrcBudget,
                },
                sb,
                { forceBypassOff: true, autonomous: true },
              );
              if (!verdict.allowed) {
                decide(c, kind, "blocked", verdict.reason ?? "blocked by guardrails");
                continue;
              }
              const res = await executeReallocation(
                shopId,
                {
                  alertId: c.alert_id,
                  sourceCampaignId: campaignId,
                  destCampaignId: dest.campaignId,
                  amountCents,
                  idempotencyKey: `autopilot:${c.alert_id}:reallocate_budget`,
                  actor: "autopilot",
                  triggerReason: autopilotReason("Auto reallocate budget", c.detector_id, c.dollar_impact),
                },
                sb,
              );
              // The executed action is a reallocation, not a plain reduction —
              // label the decision accordingly while keeping intendedKind = reduce.
              res.outcome === "succeeded"
                ? decide(c, kind, "acted", "reallocate_budget")
                : decide(c, kind, "failed", `executor outcome: ${res.outcome}`);
              // Terminal failure is a beta signal on the pair the action is
              // CALIBRATED under — reallocate_budget, the same pair the
              // isGraduated gate above read (this sub-branch bypasses record()).
              if (res.outcome === "failed") {
                notifyPromises.push(
                  recordActionFailure(shopId, c.detector_id, "reallocate_budget", sb, {
                    auditId: res.id,
                    alertId: c.alert_id,
                  }),
                );
              }
              if (res.outcome === "succeeded") {
                // Collect for await Promise.allSettled at end of run — prevents serverless abandonment.
                notifyPromises.push(
                  notifyAutonomousAction(
                    { shopId, actionDescription: `Reallocated budget from campaign ${campaignId}` },
                    merchantEmail,
                  ).catch((e) => console.error("[autopilot-notify] unexpected error (realloc)", e)),
                );
              }
              continue;
            }
          }
        }
      }

      const verdict = await checkGuardrails(
        shopId,
        {
          kind,
          campaignId,
          dollarImpactCents: Math.round(Number(c.dollar_impact) * 100),
          campaignSpendCents,
          currentBudgetCents: currentBudgetCents ?? undefined,
          newBudgetCents,
        },
        sb,
        { forceBypassOff: true, autonomous: true },
      );
      if (!verdict.allowed) {
        decide(c, kind, "blocked", verdict.reason ?? "blocked by guardrails");
        continue;
      }

      // I4: Freshness + live precondition re-check — runs AFTER graduation + guardrails
      // pass and BEFORE the executor fires. Fail-safe: a thrown check is ok:false,
      // so a DB hiccup can never silently permit an autonomous action.
      if (kind === "pause_campaign" || kind === "reduce_campaign_budget") {
        const precheck = await preconditionFresh({
          kind,
          candidate: { ...c, campaign_id: campaignId, daily_budget_cents: currentBudgetCents },
          sb,
          nowMs: Date.now(),
        });
        if (!precheck.ok) {
          console.info(`[autopilot] precondition re-check failed for ${campaignId}: ${precheck.reason}`);
          decide(c, kind, "skipped", precheck.reason ?? "precondition_failed");
          continue;
        }
      }

      // I10: For sku_stockout_vs_spend → pause_campaign specifically, also require
      // the full product-level stockout allowlist to clear. Candidate selection
      // only supplies a dedicated campaign; shared/catalog campaigns remain manual.
      if (kind === "pause_campaign" && c.detector_id === "sku_stockout_vs_spend") {
        // Load the raw alert so stockoutPauseAllowed can read entity_ref.
        const { data: alertRow } = await sb
          .from("alerts")
          .select("id, detector_id, entity_ref")
          .eq("id", c.alert_id)
          .maybeSingle();
        if (!alertRow) {
          decide(c, kind, "skipped", "stockout_allowlist: alert row not found");
          continue;
        }
        const stockCheck = await stockoutPauseAllowed({
          shopId,
          alert: alertRow,
          campaignId,
          sb,
        });
        if (!stockCheck.ok) {
          console.info(`[autopilot] stockout allowlist blocked ${campaignId}: ${stockCheck.reason}`);
          decide(c, kind, "skipped", stockCheck.reason ?? "stockout_precondition_not_met");
          continue;
        }
      }

      const res = await executeAction(
        shopId,
        {
          alertId: c.alert_id,
          kind,
          campaignId,
          idempotencyKey: `autopilot:${c.alert_id}:${kind}`,
          dailyBudgetCents: newBudgetCents,
          actor: "autopilot",
          triggerReason: autopilotReason(
            kind === "pause_campaign" ? "Auto-pause" : "Auto budget cut",
            c.detector_id,
            c.dollar_impact,
          ),
        },
        sb,
      );
      record(c, kind, res);
      if (res.outcome === "succeeded") {
        // Collect for await Promise.allSettled at end of run — prevents serverless abandonment.
        const actionLabel = kind === "pause_campaign" ? "Paused campaign" : "Reduced budget for campaign";
        notifyPromises.push(
          notifyAutonomousAction(
            { shopId, actionDescription: `${actionLabel} ${campaignId}` },
            merchantEmail,
          ).catch((e) => console.error("[autopilot-notify] unexpected error (pause/reduce)", e)),
        );
      }
    } catch (err) {
      // A throw here (DB/ownership/insert error in checkGuardrails or an
      // executor) must not abort the run — log it, count it, and move to the
      // next candidate. Retriable platform failures are already parked as
      // `retrying` by executeAction for the action-retry cron, so there is
      // nothing to retry inline; we just stop one bad alert from starving the rest.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[autopilot] candidate ${c.campaign_id} (alert ${c.alert_id}) errored: ${msg}`);
      decide(c, null, "failed", `threw: ${msg}`);
    }
  }

  // Await all notification promises before returning so Vercel cron doesn't
  // abandon them when the response is sent. allSettled: a delivery failure
  // never affects the summary (the action already landed and was recorded).
  if (notifyPromises.length > 0) {
    await Promise.allSettled(notifyPromises);
  }

  return {
    skipped: false,
    acted,
    blocked,
    skippedMoves,
    failed,
    considered: decisions.length,
    blockedReasons,
    decisions,
  };

  } finally {
    // I6: Always release the per-shop lock on completion OR error. The TTL
    // (LOCK_TTL_MS) acts as a backstop if this finally somehow doesn't run.
    await releaseAutopilotLock(shopId, lock.acquiredAt!, sb);
  }
}
