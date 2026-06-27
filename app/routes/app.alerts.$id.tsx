import { Fragment, useEffect, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteLoaderData,
  useSearchParams,
} from "@remix-run/react";
import { useEmbeddedNavigate } from "../lib/embedded-nav";
import { actionDeepLink } from "~/lib/action-deeplinks";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Badge,
  BlockStack,
  Banner,
  Box,
  Button,
  Card,
  InlineStack,
  Modal,
  Page,
  Text,
  TextField,
  Tooltip,
  useBreakpoints,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { acknowledgeAlert } from "~/lib/alerts.server";
import { snoozeAlert } from "~/lib/actions/snooze.server";
import { suggestedReorderQty } from "~/lib/actions/reorder-qty";
import { CalderynError, calderynClient } from "~/lib/calderyn.server";
import { newIdempotencyKey } from "~/lib/ids";
import { executeAction, type ExecutableKind } from "~/lib/actions/execute.server";
import type { RegionCode } from "~/lib/ads/actions";
import { resolveShopId, getSupabase } from "~/lib/supabase.server";
import { recordApproval } from "~/lib/calibration/approval.server";
import { ZERO_APPROVE_RECEIPT, type ApproveReceipt } from "~/lib/calibration/delta";
// Google/TikTok execute live only once OAuth has stored credentials; if the adapter
// resolves to null, executeAction records a failed audit with last_error set, and
// the UI surfaces the error toast — no silent swallowing.
import { transferPlanFromEvidence } from "~/lib/shopify/inventory.server";
import { inventoryAdjustQuantitiesForShop } from "~/lib/demo/showcase.server";
import {
  buildPoDraft,
  derivePoQuantity,
  getCurrentUnitCostCents,
} from "~/lib/po/draft.server";
import { fmtMoney, fmtRelTime, fmtAbsTime } from "~/lib/format";
import {
  ACTION_LABELS,
  ACTION_VERBS,
  DETECTOR_TO_ACTIONS,
} from "~/lib/labels";
import { useActionToast } from "~/lib/toast";
import { resolveActionParam } from "~/lib/assistant/action-param";
import { resolveSkuForDiscontinue } from "~/lib/actions/discontinue.server";
import { executeDiscontinueAlertAction } from "~/lib/actions/alert-action.server";
import { executeReallocateSpendSku } from "~/lib/actions/reallocate-sku.server";
import { executeAdjustPriceAlertAction } from "~/lib/actions/adjust-price.server";
import { enrichRemediation } from "~/lib/remediation/enrich.server";
import {
  DetectorTag,
  EvidencePanel,
  GuardrailMeter,
  IMPACT_LABEL,
  IMPACT_METHODOLOGY,
  NarrativeCard,
  SeverityBadge,
} from "~/components/calderyn";
import type { ActionKind, Alert, GuardrailConfig } from "~/lib/types";

type PoDefaults = { quantity: number | null; unit_cost_cents: number | null };

type LoaderPayload = {
  alert: Alert | null;
  guardrails: GuardrailConfig | null;
  poDefaults: PoDefaults | null;
  existingPoDraft: boolean;
  error: { code: string; message: string } | null;
};

type ActionPayload = {
  ok: boolean;
  toast?: { message: string; isError?: boolean };
  error?: { code: string; message: string };
  /** Trust receipt from a successful approve (drives the Action Queue's approve
   *  receipt + graduation moment). Absent for snooze/failed/deep-link. */
  calibration?: ApproveReceipt;
};

// Per-kind execution surface. Most kinds confirm + execute inline on this page;
// kinds listed here need inputs only another page collects, so every surface
// (buttons, ?action= param, keyboard shortcut) deep-links there instead, and
// the action handler rejects direct POSTs rather than write a bogus audit row.
const DEEP_LINK_ACTIONS: Partial<Record<ActionKind, { path: string; message: string }>> = {
  reallocate_budget: {
    path: "/app/campaigns",
    message: "Reallocate budget from the Campaigns page",
  },
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  // Unauthenticated confirm_url hits are rewritten to the Shopify admin deep
  // link by the parent app.tsx loader, which runs for every document request
  // matching this route — no per-route wrapper needed here.
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  const id = params.id!;
  try {
    const [alert, guardrails] = await Promise.all([
      client.alerts.get(id, request.signal),
      client.guardrails.get(request.signal),
    ]);

    // Async enrichment: fill winner/campaign target + flip reallocate_to_winner
    // from advisory to executable when eligible (Phase 3). Best-effort: enrich
    // already falls back to advisory on any DB error so the page never breaks.
    if (alert.remediation) {
      const shopId = await resolveShopId(session.shop);
      alert.remediation = await enrichRemediation(alert, alert.remediation, getSupabase(), shopId);
    }

    // Pre-fill the PO modal from the alert's evidence and the current COGS
    // row; both may be unknown (null) — the modal renders those blank/TBD.
    let poDefaults: PoDefaults | null = null;
    let existingPoDraft = false;
    if ((DETECTOR_TO_ACTIONS[alert.detector_id] ?? []).includes("create_po_draft") && alert.sku) {
      const supabase = getSupabase();
      const shopId = await resolveShopId(session.shop);
      poDefaults = {
        quantity: derivePoQuantity(alert.evidence ?? {}),
        unit_cost_cents: await getCurrentUnitCostCents(supabase, shopId, alert.sku),
      };
      // Surface (not block) repeat executions: a successful draft that hasn't
      // been undone warns in the confirm dialog. Undo rows share the
      // original's action_kind with undo_of pointing back at it, so fetch
      // both and net them out here (PostgREST can't anti-join in one query).
      const { data: priorDrafts, error: dupErr } = await supabase
        .from("action_audit")
        .select("id, undo_of")
        .eq("shop_id", shopId)
        .eq("alert_id", id)
        .eq("action_kind", "create_po_draft")
        .eq("outcome", "succeeded");
      if (dupErr) {
        // Cosmetic lookup — log loudly but don't take the page down over it.
        console.error(`[alerts] duplicate-PO lookup failed for ${id}`, dupErr);
      }
      const rows = (priorDrafts ?? []) as Array<{ id: string; undo_of: string | null }>;
      const undone = new Set(rows.map((r) => r.undo_of).filter(Boolean));
      existingPoDraft = rows.some((r) => !r.undo_of && !undone.has(r.id));
    }

    return json<LoaderPayload>({ alert, guardrails, poDefaults, existingPoDraft, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      alert: null,
      guardrails: null,
      poDefaults: null,
      existingPoDraft: false,
      error: { code: e.code ?? "ERROR", message: e.message },
    });
  }
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  const formData = await request.formData();
  const kind = String(formData.get("kind") || "") as ActionKind;
  const alertId = String(formData.get("alertId") || params.id || "");
  const idempotencyKey =
    String(formData.get("idempotencyKey") || "") || newIdempotencyKey();

  // SECURITY: hidden form fields (alertId aside) are attacker-controllable and
  // must never drive an external side effect. We re-load the alert server-side
  // (shop-scoped — get() 404s if it isn't this shop's), then derive everything
  // — the allowed action, the dollar-impact, and the inventory mutation inputs —
  // from that trusted record. `param_*` fields are intentionally ignored.
  try {
    if (!alertId) {
      throw new CalderynError({
        code: "INVALID_REQUEST",
        status: 400,
        message: "alertId is required",
      });
    }

    const alert = await client.alerts.get(alertId, request.signal);

    // Only actions this detector exposes may run against this alert.
    const allowed = DETECTOR_TO_ACTIONS[alert.detector_id] ?? ["snooze_alert"];
    if (!allowed.includes(kind)) {
      throw new CalderynError({
        code: "ACTION_NOT_ALLOWED",
        status: 403,
        message: `"${kind}" is not a permitted action for this alert.`,
      });
    }

    const deepLink = DEEP_LINK_ACTIONS[kind];
    if (deepLink) {
      return json<ActionPayload>(
        {
          ok: false,
          error: { code: "UNSUPPORTED_HERE", message: deepLink.message },
          toast: { message: deepLink.message, isError: true },
        },
        { status: 400 },
      );
    }

    // Guardrail: enforce the per-action dollar-impact cap server-side using the
    // alert's real impact (not a form value). Snooze is harmless and exempt.
    const guardrails = await client.guardrails.get(request.signal);
    // alert.dollar_impact is ALREADY in cents (rowToAlert converts the DB dollars
    // at the boundary), and so is dollar_cap_cents — compare directly. The prior
    // `* 100` double-converted, inflating the impact 100x and tripping the cap on
    // every action once a realistic (non-sentinel) cap is configured.
    const impactCents = alert.dollar_impact;
    // increase_campaign_budget is an UPSIDE action — alert.dollar_impact is the
    // projected gain, not downside risk — so the per-action risk cap does not
    // apply (it would block exactly the highest-upside scaling opportunities).
    if (
      kind !== "snooze_alert" &&
      kind !== "increase_campaign_budget" &&
      impactCents > guardrails.dollar_cap_cents
    ) {
      throw new CalderynError({
        code: "GUARDRAIL_DOLLAR_CAP",
        status: 403,
        message: `This action's impact (${fmtMoney(impactCents)}) exceeds the per-action cap of ${fmtMoney(guardrails.dollar_cap_cents)}.`,
      });
    }

    // Server-derived audit params — sourced from the alert, never the form.
    const execParams: Record<string, unknown> = {
      target: alert.campaign ?? alert.sku ?? "",
      estimate_cents: alert.dollar_impact,
    };

    if (kind === "reallocate_inventory") {
      // Inventory mutation inputs come from the alert's evidence, not the form.
      const plan = transferPlanFromEvidence(alert.evidence ?? {});
      if (!plan) {
        throw new CalderynError({
          code: "INVALID_INVENTORY_EVIDENCE",
          status: 422,
          message:
            "Alert evidence is missing the inventory item, source/destination location, or delta.",
        });
      }

      // Resolve the shop id so the inventory transfer is simulated for a
      // showcase/demo store (its seeded inventory item has no live Shopify
      // object); a real shop falls through to the live Shopify mutation.
      const invShopId = await resolveShopId(session.shop);
      const { operationId } = await inventoryAdjustQuantitiesForShop(invShopId, admin, plan, getSupabase());

      execParams.inventory_item_id = plan.inventoryItemId;
      execParams.from_location_id = plan.fromLocationId;
      execParams.to_location_id = plan.toLocationId;
      execParams.delta = plan.delta;
      execParams.shopify_operation_id = operationId;
    }

    if (kind === "create_po_draft") {
      // SECURITY EXCEPTION (intentional): unlike `param_*` fields, the
      // po_quantity/po_unit_cost form fields ARE honoured here. They shape a
      // local document only — the PO draft snapshotted into the audit row, with
      // no external side effect — and are strictly validated below. The SKU and
      // line title still come from the trusted alert record, never the form.
      // One-click Approve sends no po_quantity; default to a computed reorder
      // suggestion from the alert's velocity/lead-time so the card works without
      // a typed number. A typed quantity always wins. With no usable velocity the
      // suggestion is null, qtyRaw stays "", and validation below fails visibly.
      const typedQty = String(formData.get("po_quantity") ?? "").trim();
      const qtyRaw =
        typedQty === "" ? String(suggestedReorderQty(alert.evidence ?? {}) ?? "") : typedQty;
      const quantity = Number(qtyRaw);
      // Digits-only regex already guarantees an integer; bound it to a sane max.
      if (!/^\d+$/.test(qtyRaw) || quantity <= 0 || quantity > 1_000_000) {
        throw new CalderynError({
          code: "INVALID_PO_QUANTITY",
          status: 422,
          message: "Order quantity must be a positive whole number.",
        });
      }

      const costRaw = String(formData.get("po_unit_cost") ?? "").trim();
      let unitCostCents: number | null = null;
      if (costRaw !== "") {
        const dollars = Number(costRaw);
        if (!Number.isFinite(dollars) || dollars < 0) {
          throw new CalderynError({
            code: "INVALID_PO_UNIT_COST",
            status: 422,
            message: "Unit cost must be a non-negative dollar amount, or blank for TBD.",
          });
        }
        unitCostCents = Math.round(dollars * 100);
      }

      if (!alert.sku) {
        throw new CalderynError({
          code: "INVALID_PO_TARGET",
          status: 422,
          message: "This alert has no SKU to draft a purchase order against.",
        });
      }

      // A discontinued SKU must never be re-orderable (rule 12). Resolve the
      // flag shop-scoped from sku_dim and refuse loudly if set.
      {
        const sbCheck = getSupabase();
        const shopIdCheck = await resolveShopId(session.shop);
        const target = await resolveSkuForDiscontinue(sbCheck, shopIdCheck, alert.sku);
        if (target?.alreadyFlagged) {
          throw new CalderynError({
            code: "SKU_DISCONTINUED",
            status: 409,
            message:
              "This product is marked Do Not Reorder. Restore it (undo the discontinue) before drafting a purchase order.",
          });
        }
      }

      const ev = alert.evidence ?? {};
      const title = stringOrEmpty(ev.title) || stringOrEmpty(ev.sku_title) || alert.sku;

      execParams.po = buildPoDraft({
        alertId,
        detectorId: alert.detector_id,
        shopDomain: session.shop,
        sku: alert.sku,
        title,
        quantity,
        unitCostCents,
        now: new Date(),
      });
    }

    if (kind === "reallocate_spend_sku") {
      const shopId = await resolveShopId(session.shop);
      const { outcome } = await executeReallocateSpendSku({
        client,
        sb: getSupabase(),
        shopId,
        alertId,
        idempotencyKey,
        actor: "merchant",
        signal: request.signal,
      });
      const calibration =
        outcome === "succeeded"
          ? await recordApproval(shopId, alert.detector_id, kind, getSupabase()).catch(
              () => ZERO_APPROVE_RECEIPT,
            )
          : undefined;
      return json<ActionPayload>({
        ok: outcome === "succeeded",
        calibration,
        toast: {
          message:
            outcome === "succeeded"
              ? "Moved ad budget to your top product — logged to action history"
              : outcome === "retrying"
                ? "Couldn't reach Meta — queued, will retry automatically"
                : "Action recorded as failed — check the audit log",
          isError: outcome === "failed",
        },
      });
    }

    if (kind === "discontinue_sku") {
      const shopId = await resolveShopId(session.shop);
      const { outcome, acknowledged } = await executeDiscontinueAlertAction({
        client,
        admin,
        sb: getSupabase(),
        shopId,
        alertId,
        kind: "discontinue_sku",
        idempotencyKey,
        signal: request.signal,
      });
      const calibration =
        outcome === "succeeded"
          ? await recordApproval(shopId, alert.detector_id, kind, getSupabase()).catch(
              () => ZERO_APPROVE_RECEIPT,
            )
          : undefined;
      return json<ActionPayload>({
        ok: outcome === "succeeded",
        calibration,
        toast: {
          message:
            outcome === "succeeded"
              ? `Product discontinued — archived on Shopify and marked Do Not Reorder.${acknowledged ? "" : " Alert couldn't be acknowledged."}`
              : "Discontinue recorded as failed — check the audit log.",
          isError: outcome !== "succeeded",
        },
      });
    }

    if (kind === "adjust_price") {
      const shopId = await resolveShopId(session.shop);
      // Optional merchant override (dollars). Blank → engine restore-to-margin
      // price. Strictly validated; the executor re-bounds it to the price cap.
      const priceRaw = String(formData.get("new_price") ?? "").trim();
      let newPriceCents: number | undefined;
      if (priceRaw !== "") {
        const dollars = Number(priceRaw);
        if (!Number.isFinite(dollars) || dollars <= 0) {
          throw new CalderynError({
            code: "INVALID_PRICE",
            status: 422,
            message: "Price must be a positive dollar amount, or blank to use the suggested price.",
          });
        }
        newPriceCents = Math.round(dollars * 100);
      }
      const { outcome, acknowledged } = await executeAdjustPriceAlertAction({
        client,
        admin,
        sb: getSupabase(),
        shopId,
        alertId,
        kind: "adjust_price",
        idempotencyKey,
        newPriceCents,
        actor: "merchant",
        signal: request.signal,
      });
      const calibration =
        outcome === "succeeded"
          ? await recordApproval(shopId, alert.detector_id, kind, getSupabase()).catch(
              () => ZERO_APPROVE_RECEIPT,
            )
          : undefined;
      return json<ActionPayload>({
        ok: outcome === "succeeded",
        calibration,
        toast: {
          message:
            outcome === "succeeded"
              ? `Price updated on Shopify to restore margin — logged to action history; reversible there.${acknowledged ? "" : " Alert couldn't be acknowledged."}`
              : "Price update recorded as failed — check the audit log.",
          isError: outcome !== "succeeded",
        },
      });
    }

    // For pause_campaign and reduce_campaign_budget, route through the real
    // executeAction orchestrator when the alert's evidence carries the
    // ad_campaign_dim UUID (campaign_id). Alerts fired by the engine always
    // include this UUID; if absent we fall back to the legacy stub so the UI
    // never breaks on older or synthetic alerts.
    // Google/TikTok execute live only once OAuth has stored credentials; if the
    // adapter resolves to null, executeAction records a failed audit with
    // last_error set — no silent swallowing.
    const executableKinds: ExecutableKind[] = [
      "pause_campaign",
      "reduce_campaign_budget",
      "increase_campaign_budget",
      "exclude_geo",
    ];
    const evidenceCampaignId = stringOrEmpty(alert.evidence?.campaign_id);
    // cut_ads on a SKU alert submits the loser campaign from the remediation move
    // (the evidence has no campaign_id). executeAction validates shop ownership,
    // so a submitted id can't reach another shop's campaign.
    const moveCampaignId = stringOrEmpty(formData.get("move_campaign_id"));
    // Engine alerts carry the campaign UUID in entity_ref, which the view resolves
    // to alert.campaign_id; fall back to it so campaign actions (and exclude_geo)
    // route through the real executeAction rather than the legacy stub.
    const campaignId = moveCampaignId || evidenceCampaignId || stringOrEmpty(alert.campaign_id);

    if (executableKinds.includes(kind as ExecutableKind) && campaignId) {
      // reduce_campaign_budget: the new budget is 70% of the current daily budget.
      // Prefer the move's pre-computed reduced budget (SKU alert), else derive it
      // from the campaign budget recorded in the alert evidence (campaign alert).
      const ev = alert.evidence ?? {};
      let dailyBudgetCents: number | undefined;
      if (kind === "reduce_campaign_budget") {
        const moveReduced = Number(formData.get("move_reduced_budget_cents") ?? 0);
        if (moveReduced > 0) {
          dailyBudgetCents = Math.round(moveReduced);
        } else {
          const current = Number(ev.daily_budget_cents ?? ev.budget_cents ?? 0);
          dailyBudgetCents = current > 0 ? Math.round(current * 0.7) : undefined;
        }
      } else if (kind === "increase_campaign_budget") {
        // Scale up by the engine's suggested percent, mirroring the Campaigns
        // detail "Proposed (+X%)" card (loadScaleOpportunity reads the same keys).
        // campaign_scaling_opportunity evidence carries the budget as
        // daily_budget_usd (dollars); fall back to *_cents only if a caller ever
        // provides them. Default +20% when the percent is absent. No current
        // budget → leave undefined so executeAction fails visibly (rule 12).
        const usd = Number(ev.daily_budget_usd);
        const current =
          usd > 0 ? usd * 100 : Number(ev.daily_budget_cents ?? ev.budget_cents ?? 0);
        const pct = Number(ev.increase_pct) || 20;
        dailyBudgetCents = current > 0 ? Math.round(current * (1 + pct / 100)) : undefined;
      }

      // exclude_geo: the region to drop from the campaign's targeting comes from
      // the alert evidence (engine-produced; one of the four internal buckets).
      let region: RegionCode | undefined;
      if (kind === "exclude_geo") {
        region = (stringOrEmpty(ev.region) || undefined) as RegionCode | undefined;
      }

      const shopId = await resolveShopId(session.shop);
      const result = await executeAction(
        shopId,
        {
          alertId: alertId || null,
          kind: kind as ExecutableKind,
          campaignId,
          idempotencyKey,
          dailyBudgetCents,
          region,
        },
        getSupabase(),
      );

      let successMessage = `${ACTION_VERBS[kind] ?? "Action"} executed`;
      if (
        result.outcome === "succeeded" &&
        !(await acknowledgeAlert(getSupabase(), shopId, alertId))
      ) {
        successMessage += " — alert couldn't be acknowledged";
      }
      // Positive calibration signal on success only.
      // Never blocks the response (recordApproval never throws). Capture the
      // receipt so the Action Queue can render the approve confirmation +
      // graduation moment.
      let calibration: ApproveReceipt | undefined;
      if (result.outcome === "succeeded") {
        const sb1 = getSupabase();
        calibration = await recordApproval(shopId, alert.detector_id, kind, sb1).catch(
          () => ZERO_APPROVE_RECEIPT,
        );
      }

      return json<ActionPayload>({
        ok: result.outcome === "succeeded",
        calibration,
        toast: {
          message:
            result.outcome === "succeeded"
              ? successMessage
              : result.outcome === "retrying"
                ? "Couldn't reach the ad platform — queued, will retry automatically"
                : "Action recorded as failed — check the audit log",
          // `retrying` is pending, not an error; only terminal failure is.
          isError: result.outcome === "failed",
        },
      });
    }

    // The legacy recorder writes outcome:"succeeded" and acknowledges the alert
    // WITHOUT any platform mutation. Only three kinds may legitimately reach it:
    // snooze_alert (its real defer runs below) and reallocate_inventory /
    // create_po_draft (which performed their real work above and only need the
    // audit row written). Any other kind here has no wired executor — recording
    // success would be a phantom (rule 12). Fail visibly instead.
    const LEGACY_RECORDED_KINDS = new Set<ActionKind>([
      "snooze_alert",
      "reallocate_inventory",
      "create_po_draft",
    ]);
    if (!LEGACY_RECORDED_KINDS.has(kind as ActionKind)) {
      throw new CalderynError({
        code: "UNSUPPORTED_ACTION",
        status: 422,
        message: "This action can't be run automatically yet.",
      });
    }

    await client.actions.execute({
      alertId,
      kind,
      params: execParams,
      idempotencyKey,
    });

    // Snooze defers (hide for 1 day / until next login) rather than resolving;
    // every other kind moves the alert out of the open queue on success.
    const sb = getSupabase();
    const shopId = await resolveShopId(session.shop);
    let acknowledged = true;
    if (kind === "snooze_alert") {
      await snoozeAlert(sb, shopId, alertId);
    } else {
      acknowledged = await acknowledgeAlert(sb, shopId, alertId);
    }
    // Positive calibration signal: merchant approved this (detector, action).
    // snooze_alert is excluded -- it defers rather than approves the action.
    // Never blocks the action result (recordApproval never throws).
    let calibration: ApproveReceipt | undefined;
    if (kind !== "snooze_alert") {
      calibration = await recordApproval(shopId, alert.detector_id, kind, sb).catch(
        () => ZERO_APPROVE_RECEIPT,
      );
    }
    return json<ActionPayload>({
      ok: true,
      calibration,
      toast: {
        message: `${ACTION_VERBS[kind] ?? "Action"} executed${
          acknowledged ? "" : " — alert couldn't be acknowledged"
        }`,
      },
    });
  } catch (err) {
    if (err instanceof CalderynError) {
      return json<ActionPayload>(
        {
          ok: false,
          error: { code: err.code, message: err.message },
          toast: { message: err.message, isError: true },
        },
        { status: err.status >= 400 && err.status < 600 ? err.status : 500 },
      );
    }
    const message = (err as Error).message || "Action failed";
    return json<ActionPayload>(
      {
        ok: false,
        error: { code: "ACTION_FAILED", message },
        toast: { message, isError: true },
      },
      { status: 500 },
    );
  }
};

export default function AlertDetail() {
  const navigate = useEmbeddedNavigate();
  // Shop domain for building Shopify admin deep-links (same source embedded-nav reads).
  const shop = (useRouteLoaderData("routes/app") as { shop?: string } | undefined)?.shop ?? "";
  const { alert, guardrails, poDefaults, existingPoDraft, error } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [actionKind, setActionKind] = useState<ActionKind | null>(null);
  // cut_ads on a SKU alert: the loser campaign + its budget come from the
  // remediation move's target (the alert evidence has no campaign_id). Stashed
  // when the move is clicked so the modal can submit them.
  const [moveTarget, setMoveTarget] = useState<{ campaignId?: string; budgetCents?: number } | null>(
    null,
  );
  const [searchParams] = useSearchParams();

  useActionToast(actionData);

  useEffect(() => {
    if (!alert) return;
    const allowed = DETECTOR_TO_ACTIONS[alert.detector_id] || ["snooze_alert"];
    // Deep-linked kinds (in-app DEEP_LINK_ACTIONS or external actionDeepLink such
    // as free-ship / exclude_geo) have no inline confirm modal — opening one would
    // dead-end on submit (422), so exclude them; the deep-link button stays.
    const fromUrl = resolveActionParam(
      searchParams.get("action"),
      allowed.filter((k) => !DEEP_LINK_ACTIONS[k] && !actionDeepLink(k, shop)),
    );
    if (fromUrl) setActionKind(fromUrl);
  }, [alert, searchParams, shop]);

  useEffect(() => {
    if (actionData?.ok) {
      setActionKind(null);
      navigate("/app/alerts");
    }
  }, [actionData, navigate]);

  useEffect(() => {
    if (!alert) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const allowed = DETECTOR_TO_ACTIONS[alert.detector_id] || ["snooze_alert"];
      // Deep-linked kinds (in-app or external actionDeepLink) have no inline
      // confirm modal — skip them so the shortcut lands on a real inline action
      // rather than opening a modal that dead-ends on submit (422).
      const inlineKinds = allowed.filter((k) => !DEEP_LINK_ACTIONS[k] && !actionDeepLink(k, shop));
      if (e.key === "e" && inlineKinds[0]) setActionKind(inlineKinds[0]);
      if (e.key === "s") setActionKind("snooze_alert");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [alert, shop]);

  if (error) {
    return (
      <Page>
        <Banner tone="critical" title="Couldn't load alert">
          <p>{error.message}</p>
          <Button onClick={() => navigate("/app/alerts")}>Back to alerts</Button>
        </Banner>
      </Page>
    );
  }

  if (!alert) {
    return (
      <Page>
        <Banner tone="warning" title="Alert not found">
          <Button onClick={() => navigate("/app/alerts")}>Back to alerts</Button>
        </Banner>
      </Page>
    );
  }

  const allowedActions = DETECTOR_TO_ACTIONS[alert.detector_id] || ["snooze_alert"];

  // When a remediation block is present, its executable moves (m.executor truthy,
  // m.kind !== "snooze") are the canonical surface for those action kinds. Remove
  // those executor kinds from allowedActions so they don't render a second time
  // below. snooze_alert is always kept here — the moves block excludes snooze
  // intentionally, so it must still appear once via allowedActions.
  const remediationExecutorKinds: Set<ActionKind> = alert.remediation
    ? new Set(
        alert.remediation.moves
          .filter((m) => m.kind !== "snooze" && !!m.executor)
          .map((m) => m.executor as ActionKind),
      )
    : new Set();
  // Campaign-budget kinds on the legacy path need a campaign to act on. Without
  // one, the action handler's executableKinds branch (which requires campaignId)
  // is skipped and the kind 422s — a dead button. Drop them when the alert has no
  // campaign_id, matching the executable path's precondition (rule 12).
  const hasCampaign = !!stringOrEmpty(alert.evidence?.campaign_id);
  const CAMPAIGN_BUDGET_KINDS: Set<ActionKind> = new Set([
    "pause_campaign",
    "reduce_campaign_budget",
    "increase_campaign_budget",
  ]);
  const dedupedAllowedActions = allowedActions.filter(
    (k) =>
      k === "snooze_alert" ||
      (!remediationExecutorKinds.has(k) && (!CAMPAIGN_BUDGET_KINDS.has(k) || hasCampaign)),
  );

  const submitting = navigation.state !== "idle";
  const evidence = alert.evidence ?? {};

  // UI guard: the "Best-seller may sell out" (scaling_sku_fulfillment_risk) copy
  // contradicts its own evidence when on-hand stock / days-of-cover are already 0
  // — the product isn't going to sell out, it's already out. Reframe the headline
  // and add a clarifying note so the copy never argues with the numbers below.
  // (The engine-side detector boundary is the real fix — flagged separately.)
  const soldOut =
    alert.detector_id === "scaling_sku_fulfillment_risk" &&
    (Number(evidence.stock) === 0 || Number(evidence.days_of_cover) === 0);
  const productName =
    stringOrEmpty(evidence.title) || stringOrEmpty(evidence.sku_title) || alert.sku || "";
  const headline =
    soldOut && productName ? `${productName} is sold out — restock now` : alert.title;

  return (
    <Page
      title={headline}
      backAction={{ content: "Alerts", onAction: () => navigate("/app/alerts") }}
      titleMetadata={
        <InlineStack gap="200">
          <SeverityBadge severity={alert.severity} />
          <DetectorTag detectorId={alert.detector_id} evidence={alert.evidence} />
        </InlineStack>
      }
      subtitle={`Detected ${fmtAbsTime(alert.created_at)} · ${fmtRelTime(alert.created_at)}`}
    >
      <div className="alx-detail">
        {/* LEFT MAIN */}
        <div className="alx-detail-main">
          {actionData?.error && (
            <Banner tone="critical" title="Action failed">
              <p>{actionData.error.message}</p>
            </Banner>
          )}

          {/* Critical "already sold out" banner — design's red-header card,
              rendered only when the alert's own evidence shows a real stockout. */}
          {soldOut && (
            <div className="alx-crit">
              <div className="alx-crit-head">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  aria-hidden="true"
                >
                  <path d="M12 9v4M12 17h.01" />
                  <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
                </svg>
                <span>This product is already sold out</span>
              </div>
              <p className="alx-crit-body">
                On-hand stock is <strong>0 units</strong> — this isn&apos;t a &ldquo;may sell
                out&rdquo; risk, it&apos;s a stockout. Restock now, and pause or exclude the ad
                spend below until inventory is back, so you stop paying for demand you can&apos;t
                fill.
              </p>
            </div>
          )}

          {/* "The take" — shared NarrativeCard renders the real Claude narrative
              + priority rank in the design's accented-left card. */}
          <NarrativeCard rank={alert.claude_rank}>{alert.narrative}</NarrativeCard>

          {/* "What we noticed" — real evidence grid inside the design's card chrome. */}
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingSm">
                What we noticed
              </Text>
              {/* title/sku_title duplicate the page header; threshold is an
                  internal tuning constant, not merchant-facing signal. */}
              <EvidencePanel evidence={evidence} hideKeys={["sku_title", "title", "threshold"]} />
            </BlockStack>
          </Card>
        </div>

        {/* RIGHT SIDEBAR — sticky on desktop (CSS), stacked on phones. */}
        <div className="alx-detail-side">
          {/* Recommended action */}
          <div className="alx-side-card">
            <div className="alx-side-pad">
              <Text as="h2" variant="headingSm">
                Recommended action
              </Text>
              <Tooltip content={IMPACT_METHODOLOGY}>
                <span className="alx-loss-label">{IMPACT_LABEL}</span>
              </Tooltip>
              <div className="alx-loss-val">{fmtMoney(alert.dollar_impact)}</div>
              <BlockStack gap="300">
                {alert.remediation && (
                  <BlockStack gap="200">
                    {alert.rec_detail && (
                      <Text as="p" variant="bodyMd">
                        {alert.rec_detail}
                      </Text>
                    )}
                    {alert.remediation.moves
                      .filter((m) => m.kind !== "snooze")
                      .map((m) => {
                        const rec = m.kind === alert.remediation!.recommended;
                        if (m.executor) {
                          // Executable move. The kind submitted is the EXECUTOR,
                          // which the action handler + DETECTOR_TO_ACTIONS gate on.
                          // Tone: critical for destructive kinds (discontinue); primary
                          // for value-recovering kinds (reallocate, cut_ads, etc.).
                          const isDestructive = m.executor === "discontinue_sku";
                          return (
                            <InlineStack key={m.kind} gap="200" blockAlign="center" wrap={false}>
                              {rec && <Badge tone="success">Recommended</Badge>}
                              <Button
                                variant={rec ? "primary" : "secondary"}
                                tone={isDestructive ? "critical" : undefined}
                                loading={navigation.state !== "idle" && actionKind === m.executor}
                                onClick={() => {
                                  setActionKind(m.executor as ActionKind);
                                  setMoveTarget(
                                    m.target?.loserCampaignId
                                      ? {
                                          campaignId: m.target.loserCampaignId,
                                          budgetCents: m.target.loserCampaignBudgetCents,
                                        }
                                      : null,
                                  );
                                }}
                              >
                                {m.label}
                              </Button>
                            </InlineStack>
                          );
                        }
                        // Advisory move (cut_ads / reallocate_to_winner / fix_returns
                        // / review_pricing) — guidance text with optional ineligibleReason.
                        return (
                          <InlineStack key={m.kind} gap="150" blockAlign="center" wrap={false}>
                            {rec && <Badge tone="success">Recommended</Badge>}
                            <Text as="span" variant="bodyMd" fontWeight={rec ? "semibold" : "regular"}>
                              {m.label}
                            </Text>
                            {m.ineligibleReason && (
                              <Text as="span" variant="bodyXs" tone="subdued">
                                — {m.ineligibleReason}
                              </Text>
                            )}
                            {m.deepLink && (
                              <Button
                                variant="plain"
                                url={m.deepLink.external ? m.deepLink.href : undefined}
                                external={m.deepLink.external || undefined}
                                onClick={
                                  m.deepLink.external
                                    ? undefined
                                    : () => navigate(m.deepLink!.href)
                                }
                              >
                                {m.deepLink.label}
                              </Button>
                            )}
                          </InlineStack>
                        );
                      })}
                    <Text as="p" variant="bodyXs" tone="subdued">
                      Advisory moves are guidance; the highlighted action runs with one click.
                    </Text>
                  </BlockStack>
                )}
                {dedupedAllowedActions.map((kind, i) => {
                  const deepLink = DEEP_LINK_ACTIONS[kind];
                  // Kinds with no one-click executor (free-ship) deep-link to where
                  // the merchant does it manually in Shopify admin — an external
                  // link, never the execute path (which would 422). rule 12.
                  const adminDeepLink = shop ? actionDeepLink(kind, shop) : null;
                  const button = adminDeepLink ? (
                    <Button fullWidth url={adminDeepLink.href} external>
                      {adminDeepLink.label} →
                    </Button>
                  ) : deepLink ? (
                    <Button fullWidth onClick={() => navigate(deepLink.path)}>
                      {ACTION_LABELS[kind]} →
                    </Button>
                  ) : (
                    <Button
                      variant={i === 0 && !alert.remediation?.recommended ? "primary" : undefined}
                      onClick={() => setActionKind(kind)}
                      fullWidth
                    >
                      {ACTION_LABELS[kind]}
                    </Button>
                  );
                  // When a remediation plan already emphasises its recommended
                  // move above, don't also stamp "Recommended" on the first
                  // legacy action (would show two recommendations).
                  return i === 0 && !alert.remediation?.recommended ? (
                    <BlockStack key={kind} gap="100">
                      {button}
                      <InlineStack gap="150" blockAlign="center">
                        <Badge tone="success">Recommended</Badge>
                        <Text as="span" variant="bodyXs" tone="subdued">
                          best at preventing the loss above
                        </Text>
                      </InlineStack>
                    </BlockStack>
                  ) : (
                    <Fragment key={kind}>{button}</Fragment>
                  );
                })}
              </BlockStack>
            </div>
          </div>

          {/* Your action limits / guardrails */}
          {guardrails && (
            <div className="alx-side-card">
              <div className="alx-side-pad">
                <div className="alx-limits-head">
                  <Text as="h2" variant="headingSm">
                    {guardrails.autopilot_enabled ? "Before Autopilot acts" : "Your action limits"}
                  </Text>
                  <span
                    className={`alx-ap ${guardrails.autopilot_enabled ? "alx-ap-on" : "alx-ap-off"}`}
                  >
                    {guardrails.autopilot_enabled ? "Autopilot on" : "Autopilot off"}
                  </span>
                </div>
                <Text as="p" variant="bodySm" tone="subdued">
                  {guardrails.autopilot_enabled
                    ? "Autopilot only runs an action when every check below passes. If any fail, the action waits for your approval."
                    : "Autopilot is off — nothing runs without your approval. These limits apply to actions you approve here, and to Autopilot if you turn it on in Settings."}
                </Text>
                <Box paddingBlockStart="300">
                  <GuardrailMeter
                    label="Today's action budget"
                    usedCents={guardrails.daily_action_budget_used_cents}
                    totalCents={guardrails.daily_action_budget_cents}
                    checks={[
                      {
                        label: `Budget for today · ${fmtMoney(
                          guardrails.daily_action_budget_cents -
                            guardrails.daily_action_budget_used_cents,
                        )} left`,
                        ok:
                          guardrails.daily_action_budget_cents -
                            guardrails.daily_action_budget_used_cents >
                          0,
                      },
                      {
                        label: `Per-action cap · ${fmtMoney(guardrails.dollar_cap_cents)} max risk per action`,
                        // alert.dollar_impact is already cents (see action handler above).
                        ok: alert.dollar_impact <= guardrails.dollar_cap_cents,
                      },
                      {
                        label: `Business hours · ${formatHour(
                          guardrails.business_hours.start,
                        )} – ${formatHour(guardrails.business_hours.end)} ${guardrails.business_hours.tz}`,
                        ok: guardrails.in_business_hours,
                      },
                    ]}
                  />
                </Box>
                <div className="alx-limits-foot">
                  Min {guardrails.cooldown_minutes} min between actions on the same campaign.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {actionKind && (
        <ExecuteActionModal
          alert={alert}
          kind={actionKind}
          poDefaults={poDefaults}
          existingPoDraft={existingPoDraft}
          moveTarget={moveTarget}
          submitting={submitting}
          onClose={() => {
            setActionKind(null);
            setMoveTarget(null);
          }}
        />
      )}
    </Page>
  );
}

function ExecuteActionModal({
  alert,
  kind,
  poDefaults,
  existingPoDraft,
  moveTarget,
  submitting,
  onClose,
}: {
  alert: Alert;
  kind: ActionKind;
  poDefaults: PoDefaults | null;
  existingPoDraft: boolean;
  moveTarget: { campaignId?: string; budgetCents?: number } | null;
  submitting: boolean;
  onClose: () => void;
}) {
  const idempotencyKey = useStableIdempotencyKey(alert.id, kind);
  const evidence = alert.evidence ?? {};

  // PO qty/price are the one set of form fields the server honours (strictly
  // validated; they shape a local document only). Pre-filled from derived
  // defaults; a blank unit cost prints as "TBD" on the PDF.
  const [poQuantity, setPoQuantity] = useState(
    poDefaults?.quantity != null ? String(poDefaults.quantity) : "",
  );
  const [poUnitCost, setPoUnitCost] = useState(
    poDefaults?.unit_cost_cents != null
      ? (poDefaults.unit_cost_cents / 100).toFixed(2)
      : "",
  );
  // adjust_price: optional override (dollars). Blank → engine restore-to-margin price.
  const [newPrice, setNewPrice] = useState("");
  const { smDown } = useBreakpoints();

  const inventoryHints =
    kind === "reallocate_inventory"
      ? {
          inventoryItemId: stringOrEmpty(evidence.inventory_item_id),
          fromLocationId: stringOrEmpty(evidence.from_location_id),
          toLocationId: stringOrEmpty(evidence.to_location_id),
          delta: stringOrEmpty(evidence.recommended_delta ?? evidence.delta),
        }
      : null;

  const missingInventoryFields =
    inventoryHints &&
    (!inventoryHints.inventoryItemId ||
      !inventoryHints.fromLocationId ||
      !inventoryHints.toLocationId ||
      !inventoryHints.delta);

  return (
    <Modal open onClose={onClose} title={ACTION_LABELS[kind]}>
      <Modal.Section>
        <Form method="post" preventScrollReset>
          {/* The server re-loads the alert and derives the action target, dollar
              impact, and inventory inputs from its trusted evidence — so only the
              identifiers needed to locate the alert + dedupe are submitted. The
              PO qty/cost fields are the validated exception (local document only). */}
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="alertId" value={alert.id} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          {/* cut_ads on a SKU alert: target the loser campaign from the move (the
              evidence carries no campaign_id). The server validates ownership. */}
          {moveTarget?.campaignId &&
            (kind === "pause_campaign" || kind === "reduce_campaign_budget") && (
              <>
                <input type="hidden" name="move_campaign_id" value={moveTarget.campaignId} />
                {kind === "reduce_campaign_budget" && moveTarget.budgetCents != null && (
                  <input
                    type="hidden"
                    name="move_reduced_budget_cents"
                    value={String(Math.round(moveTarget.budgetCents * 0.7))}
                  />
                )}
              </>
            )}
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd" tone="subdued">
              {actionDescription(kind)}
            </Text>
            {kind === "create_po_draft" && existingPoDraft && (
              <Banner tone="warning">
                A PO draft for this alert already exists in the audit log. Executing again
                creates another draft.
              </Banner>
            )}
            {kind === "create_po_draft" && (() => {
              const poFields = (
                <>
                  <TextField
                    label="Quantity"
                    name="po_quantity"
                    type="number"
                    min={1}
                    max={1_000_000}
                    value={poQuantity}
                    onChange={setPoQuantity}
                    autoComplete="off"
                  />
                  <TextField
                    label="Unit cost"
                    name="po_unit_cost"
                    type="number"
                    min={0}
                    step={0.01}
                    prefix="$"
                    value={poUnitCost}
                    onChange={setPoUnitCost}
                    autoComplete="off"
                    helpText="Leave blank if unknown — printed as TBD."
                  />
                </>
              );
              return smDown ? (
                <BlockStack gap="200">{poFields}</BlockStack>
              ) : (
                <InlineStack gap="200" wrap={false}>{poFields}</InlineStack>
              );
            })()}
            {kind === "adjust_price" && (
              <TextField
                label="New price"
                name="new_price"
                type="number"
                min={0}
                step={0.01}
                prefix="$"
                value={newPrice}
                onChange={setNewPrice}
                autoComplete="off"
                helpText="Leave blank to use the suggested price that restores this product's margin. Bounded by your price-change guardrail."
              />
            )}
            {missingInventoryFields ? (
              <Banner tone="critical">
                Alert evidence is missing the inventory item, source location, destination, or
                delta. Resolve the alert from the backend first.
              </Banner>
            ) : (
              <Banner tone="info">
                Estimated dollar impact:{" "}
                <Text as="span" fontWeight="semibold">
                  {fmtMoney(alert.dollar_impact)}
                </Text>{" "}
                {kind === "increase_campaign_budget"
                  ? "added upside over 30 days."
                  : "recovered over 30 days."}
              </Banner>
            )}
            <InlineStack align="end" gap="200">
              <Button onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              <Button
                submit
                variant="primary"
                loading={submitting}
                disabled={submitting || !!missingInventoryFields}
              >
                {/* The button names the action, not a bare "Execute" — and only
                    value-recovering kinds claim a saving (a snooze defers the
                    loss, it doesn't recover it). */}
                {kind === "snooze_alert" || alert.dollar_impact <= 0
                  ? ACTION_LABELS[kind]
                  : kind === "increase_campaign_budget"
                    ? `${ACTION_LABELS[kind]} · +${fmtMoney(alert.dollar_impact)}/mo upside`
                    : `${ACTION_LABELS[kind]} · saves ${fmtMoney(alert.dollar_impact)}`}
              </Button>
            </InlineStack>
          </BlockStack>
        </Form>
      </Modal.Section>
    </Modal>
  );
}

function useStableIdempotencyKey(alertId: string, kind: ActionKind) {
  const [key] = useState(() => `${alertId}:${kind}:${newIdempotencyKey()}`);
  return key;
}

// "14:00" → "2 PM"; "00:00" → "midnight"; "12:00" → "noon".
// Falls through to the raw string if it doesn't look like HH:MM.
function formatHour(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  const mins = Number(m[2]);
  if (!Number.isFinite(h) || h < 0 || h > 23) return hhmm;
  if (h === 0 && mins === 0) return "midnight";
  if (h === 12 && mins === 0) return "noon";
  const period = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return mins === 0 ? `${hour12} ${period}` : `${hour12}:${m[2]} ${period}`;
}

function stringOrEmpty(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

function actionDescription(kind: ActionKind) {
  switch (kind) {
    case "pause_campaign":
      return "Pauses the campaign immediately via the Meta/Google API. Reversible via Undo.";
    case "resume_campaign":
      return "Resumes the paused campaign via the ad platform API.";
    case "reduce_campaign_budget":
      return "Reduces daily budget by 30% (historical bend point). Reversible via Undo.";
    case "increase_campaign_budget":
      return "Raises this campaign's daily budget by the engine's suggested percent via the ad platform API. Reversible via Undo.";
    case "exclude_geo":
      // exclude_geo has no executor — it renders as a deep-link, not this modal.
      return "Open Ads Manager to exclude this region from the campaign's location targeting.";
    case "reallocate_inventory":
      return "Transfers inventory between locations via Shopify. Reversible via Undo.";
    case "create_po_draft":
      return "Drafts a purchase order and records it in the action audit log, where the PDF can be downloaded. Review and send to your supplier manually.";
    case "reallocate_spend_sku":
      return "Shifts half of this product's daily ad budget to your top-ranked winner product. Fully reversible via Undo. Meta only — both campaigns must be active and dedicated to their SKU.";
    case "discontinue_sku":
      return "Archives this product on Shopify and marks it Do Not Reorder, blocking future PO drafts. Fully reversible — undo re-activates the product and clears the flag.";
    case "adjust_price":
      return "Raises this product's selling price on Shopify to restore its pre-erosion margin. Leave the field blank to use the suggested price, or set your own within your price-change guardrail. Fully reversible via Undo.";
    case "snooze_alert":
      return "Suppresses this alert until the condition resolves. Calderyn re-evaluates on the next detection pass.";
  }
}
