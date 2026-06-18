import { Fragment, useEffect, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
} from "@remix-run/react";
import { useEmbeddedNavigate } from "../lib/embedded-nav";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Badge,
  BlockStack,
  Banner,
  Button,
  Card,
  InlineStack,
  Layout,
  Modal,
  Page,
  Text,
  TextField,
  Tooltip,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { acknowledgeAlert } from "~/lib/alerts.server";
import { snoozeAlert } from "~/lib/actions/snooze.server";
import { CalderynError, calderynClient } from "~/lib/calderyn.server";
import { newIdempotencyKey } from "~/lib/ids";
import { executeAction, type ExecutableKind } from "~/lib/actions/execute.server";
import { resolveShopId, getSupabase } from "~/lib/supabase.server";
// Google/TikTok execute live only once OAuth has stored credentials; if the adapter
// resolves to null, executeAction records a failed audit with last_error set, and
// the UI surfaces the error toast — no silent swallowing.
import {
  inventoryAdjustQuantities,
  transferPlanFromEvidence,
} from "~/lib/shopify/inventory.server";
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
    // alert.dollar_impact is dollars; dollar_cap_cents is cents — compare in cents
    // so the per-action cap actually enforces its dollar amount (P1-8).
    const impactCents = Math.round(alert.dollar_impact * 100);
    if (kind !== "snooze_alert" && impactCents > guardrails.dollar_cap_cents) {
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

      const { operationId } = await inventoryAdjustQuantities(admin, plan);

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
      const qtyRaw = String(formData.get("po_quantity") ?? "").trim();
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

    // For pause_campaign and reduce_campaign_budget, route through the real
    // executeAction orchestrator when the alert's evidence carries the
    // ad_campaign_dim UUID (campaign_id). Alerts fired by the engine always
    // include this UUID; if absent we fall back to the legacy stub so the UI
    // never breaks on older or synthetic alerts.
    // Google/TikTok execute live only once OAuth has stored credentials; if the
    // adapter resolves to null, executeAction records a failed audit with
    // last_error set — no silent swallowing.
    const executableKinds: ExecutableKind[] = ["pause_campaign", "reduce_campaign_budget"];
    const evidenceCampaignId = stringOrEmpty(alert.evidence?.campaign_id);

    if (executableKinds.includes(kind as ExecutableKind) && evidenceCampaignId) {
      // resolve_campaign_budget: compute the new budget as 70 % of the campaign's
      // current daily_budget_cents recorded in evidence (30 % reduction).
      const ev = alert.evidence ?? {};
      let dailyBudgetCents: number | undefined;
      if (kind === "reduce_campaign_budget") {
        const current = Number(ev.daily_budget_cents ?? ev.budget_cents ?? 0);
        dailyBudgetCents = current > 0 ? Math.round(current * 0.7) : undefined;
      }

      const shopId = await resolveShopId(session.shop);
      const result = await executeAction(
        shopId,
        {
          alertId: alertId || null,
          kind: kind as ExecutableKind,
          campaignId: evidenceCampaignId,
          idempotencyKey,
          dailyBudgetCents,
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

      return json<ActionPayload>({
        ok: result.outcome === "succeeded",
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

    // All other intents (snooze_alert, exclude_geo, reallocate_inventory,
    // create_po_draft) and pause/budget actions without a campaign_id UUID
    // in evidence stay on the legacy client path.
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
    return json<ActionPayload>({
      ok: true,
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
  const { alert, guardrails, poDefaults, existingPoDraft, error } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [actionKind, setActionKind] = useState<ActionKind | null>(null);
  const [searchParams] = useSearchParams();

  useActionToast(actionData);

  useEffect(() => {
    if (!alert) return;
    const allowed = DETECTOR_TO_ACTIONS[alert.detector_id] || ["snooze_alert"];
    // Deep-linked kinds have no inline confirm modal — opening one would only
    // 400 on submit, so the param is ignored and the deep-link button remains.
    const fromUrl = resolveActionParam(
      searchParams.get("action"),
      allowed.filter((k) => !DEEP_LINK_ACTIONS[k]),
    );
    if (fromUrl) setActionKind(fromUrl);
  }, [alert, searchParams]);

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
      // Deep-linked kinds have no inline confirm modal. Skip them so the
      // shortcut lands on the first actionable kind rather than silently
      // firing a server 400.
      const inlineKinds = allowed.filter((k) => !DEEP_LINK_ACTIONS[k]);
      if (e.key === "e" && inlineKinds[0]) setActionKind(inlineKinds[0]);
      if (e.key === "s") setActionKind("snooze_alert");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [alert]);

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
          <DetectorTag detectorId={alert.detector_id} />
        </InlineStack>
      }
      subtitle={`Detected ${fmtAbsTime(alert.created_at)} · ${fmtRelTime(alert.created_at)}`}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData?.error && (
              <Banner tone="critical" title="Action failed">
                <p>{actionData.error.message}</p>
              </Banner>
            )}
            {soldOut && (
              <Banner tone="critical" title="This product is already sold out">
                <p>
                  On-hand stock is 0 — this isn&apos;t a &ldquo;may sell out&rdquo; risk, it&apos;s
                  a stockout. Restock now, and pause or exclude the spend below until inventory is
                  back so you stop paying for demand you can&apos;t fill.
                </p>
              </Banner>
            )}
            <NarrativeCard rank={alert.claude_rank}>{alert.narrative}</NarrativeCard>

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
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingSm">
                    Recommended actions
                  </Text>
                  <Tooltip content={IMPACT_METHODOLOGY}>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {IMPACT_LABEL}
                    </Text>
                  </Tooltip>
                  <Text as="p" variant="headingLg">
                    {fmtMoney(alert.dollar_impact)}
                  </Text>
                </BlockStack>
                <BlockStack gap="300">
                  {allowedActions.map((kind, i) => {
                    const deepLink = DEEP_LINK_ACTIONS[kind];
                    const button = deepLink ? (
                      <Button fullWidth onClick={() => navigate(deepLink.path)}>
                        {ACTION_LABELS[kind]} →
                      </Button>
                    ) : (
                      <Button
                        variant={i === 0 ? "primary" : undefined}
                        onClick={() => setActionKind(kind)}
                        fullWidth
                      >
                        {ACTION_LABELS[kind]}
                      </Button>
                    );
                    return i === 0 ? (
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
              </BlockStack>
            </Card>

            {guardrails && (
              <Card>
                <BlockStack gap="300">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingSm">
                      {guardrails.autopilot_enabled ? "Before Autopilot acts" : "Your action limits"}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {guardrails.autopilot_enabled
                        ? "Autopilot only runs an action when every check below passes. If any fail, the action waits for your approval."
                        : "Autopilot is off — nothing runs without your approval. These limits apply to actions you approve here, and to Autopilot if you turn it on in Settings."}
                    </Text>
                  </BlockStack>
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
                        ok: Math.round(alert.dollar_impact * 100) <= guardrails.dollar_cap_cents,
                      },
                      {
                        label: `Business hours · ${formatHour(
                          guardrails.business_hours.start,
                        )} – ${formatHour(guardrails.business_hours.end)} ${guardrails.business_hours.tz}`,
                        ok: guardrails.in_business_hours,
                      },
                    ]}
                  />
                  <Text as="p" variant="bodyXs" tone="subdued">
                    Min {guardrails.cooldown_minutes} min between actions on the same campaign.
                  </Text>
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>

      {actionKind && (
        <ExecuteActionModal
          alert={alert}
          kind={actionKind}
          poDefaults={poDefaults}
          existingPoDraft={existingPoDraft}
          submitting={submitting}
          onClose={() => setActionKind(null)}
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
  submitting,
  onClose,
}: {
  alert: Alert;
  kind: ActionKind;
  poDefaults: PoDefaults | null;
  existingPoDraft: boolean;
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
            {kind === "create_po_draft" && (
              <InlineStack gap="200" wrap={false}>
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
              </InlineStack>
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
                recovered over 30 days.
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
    case "exclude_geo":
      return "Adds region to campaign exclusions for 7 days. Reversible via Undo.";
    case "reallocate_inventory":
      return "Transfers inventory between locations via Shopify. Reversible via Undo.";
    case "create_po_draft":
      return "Drafts a purchase order and records it in the action audit log, where the PDF can be downloaded. Review and send to your supplier manually.";
    case "snooze_alert":
      return "Suppresses this alert until the condition resolves. Calderyn re-evaluates on the next detection pass.";
  }
}
