import { useEffect, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSearchParams,
} from "@remix-run/react";
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
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { CalderynError, calderynClient } from "~/lib/calderyn.server";
import { newIdempotencyKey } from "~/lib/ids";
import { inventoryAdjustQuantities } from "~/lib/shopify/inventory.server";
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
  NarrativeCard,
  SeverityBadge,
} from "~/components/calderyn";
import type { ActionKind, Alert, GuardrailConfig } from "~/lib/types";

type LoaderPayload = {
  alert: Alert | null;
  guardrails: GuardrailConfig | null;
  error: { code: string; message: string } | null;
};

type ActionPayload = {
  ok: boolean;
  toast?: { message: string; isError?: boolean };
  error?: { code: string; message: string };
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  const id = params.id!;
  try {
    const [alert, guardrails] = await Promise.all([
      client.alerts.get(id, request.signal),
      client.guardrails.get(request.signal),
    ]);
    return json<LoaderPayload>({ alert, guardrails, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      alert: null,
      guardrails: null,
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

    // Guardrail: enforce the per-action dollar-impact cap server-side using the
    // alert's real impact (not a form value). Snooze is harmless and exempt.
    const guardrails = await client.guardrails.get(request.signal);
    if (kind !== "snooze_alert" && alert.dollar_impact > guardrails.dollar_cap_cents) {
      throw new CalderynError({
        code: "GUARDRAIL_DOLLAR_CAP",
        status: 403,
        message: `This action's impact (${fmtMoney(alert.dollar_impact)}) exceeds the per-action cap of ${fmtMoney(guardrails.dollar_cap_cents)}.`,
      });
    }

    // Server-derived audit params — sourced from the alert, never the form.
    const execParams: Record<string, unknown> = {
      target: alert.campaign ?? alert.sku ?? "",
      estimate_cents: alert.dollar_impact,
    };

    if (kind === "reallocate_inventory") {
      // Inventory mutation inputs come from the alert's evidence, not the form.
      const ev = alert.evidence ?? {};
      const inventoryItemId = stringOrEmpty(ev.inventory_item_id);
      const fromLocationId = stringOrEmpty(ev.from_location_id);
      const toLocationId = stringOrEmpty(ev.to_location_id);
      const delta = Number(ev.recommended_delta ?? ev.delta ?? 0);

      if (!inventoryItemId || !fromLocationId || !toLocationId || !delta) {
        throw new CalderynError({
          code: "INVALID_INVENTORY_EVIDENCE",
          status: 422,
          message:
            "Alert evidence is missing the inventory item, source/destination location, or delta.",
        });
      }

      const { operationId } = await inventoryAdjustQuantities(admin, {
        inventoryItemId,
        fromLocationId,
        toLocationId,
        delta,
      });

      execParams.inventory_item_id = inventoryItemId;
      execParams.from_location_id = fromLocationId;
      execParams.to_location_id = toLocationId;
      execParams.delta = delta;
      execParams.shopify_operation_id = operationId;
    }

    await client.actions.execute({
      alertId,
      kind,
      params: execParams,
      idempotencyKey,
    });

    return json<ActionPayload>({
      ok: true,
      toast: { message: `${ACTION_VERBS[kind] ?? "Action"} executed` },
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
  const navigate = useNavigate();
  const { alert, guardrails, error } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [actionKind, setActionKind] = useState<ActionKind | null>(null);
  const [searchParams] = useSearchParams();

  useActionToast(actionData);

  useEffect(() => {
    if (!alert) return;
    const allowed = DETECTOR_TO_ACTIONS[alert.detector_id] || ["snooze_alert"];
    const fromUrl = resolveActionParam(searchParams.get("action"), allowed);
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
      if (e.key === "e") setActionKind(allowed[0]);
      if (e.key === "s") setActionKind("snooze_alert");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [alert]);

  if (error) {
    return (
      <Page>
        <Banner tone="critical" title="Couldn't load alert">
          <p>
            {error.code}: {error.message}
          </p>
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

  return (
    <Page
      title={alert.title}
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
                <p>
                  {actionData.error.code}: {actionData.error.message}
                </p>
              </Banner>
            )}
            <NarrativeCard rank={alert.claude_rank}>{alert.narrative}</NarrativeCard>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingSm">
                  Why this fired — evidence
                </Text>
                <EvidencePanel evidence={evidence} />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingSm">
                  Recommended actions
                </Text>
                <InlineStack gap="200" align="end">
                  <Text as="p" variant="headingLg">
                    {fmtMoney(alert.dollar_impact)}
                  </Text>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  30-day projected impact
                </Text>
                <BlockStack gap="300">
                  {allowedActions.map((kind, i) =>
                    i === 0 ? (
                      <BlockStack key={kind} gap="100">
                        <Button variant="primary" onClick={() => setActionKind(kind)} fullWidth>
                          {ACTION_LABELS[kind]}
                        </Button>
                        <InlineStack gap="150" blockAlign="center">
                          <Badge tone="success">Recommended</Badge>
                          <Text as="span" variant="bodyXs" tone="subdued">
                            protects {fmtMoney(alert.dollar_impact)} / 30d
                          </Text>
                        </InlineStack>
                      </BlockStack>
                    ) : (
                      <Button key={kind} onClick={() => setActionKind(kind)} fullWidth>
                        {ACTION_LABELS[kind]}
                      </Button>
                    ),
                  )}
                </BlockStack>
              </BlockStack>
            </Card>

            {guardrails && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingSm">
                    Safety net
                  </Text>
                  <GuardrailMeter
                    usedCents={guardrails.daily_action_budget_used_cents}
                    totalCents={guardrails.daily_action_budget_cents}
                    checks={[
                      {
                        label: `Within daily budget · ${fmtMoney(
                          guardrails.daily_action_budget_cents -
                            guardrails.daily_action_budget_used_cents,
                        )} left`,
                        ok:
                          guardrails.daily_action_budget_cents -
                            guardrails.daily_action_budget_used_cents >
                          0,
                      },
                      {
                        label: `Under per-action cap · ${fmtMoney(guardrails.dollar_cap_cents)}`,
                        ok: alert.dollar_impact <= guardrails.dollar_cap_cents,
                      },
                      {
                        label: `Business hours · ${guardrails.business_hours.start}–${guardrails.business_hours.end}`,
                        ok: guardrails.in_business_hours,
                      },
                    ]}
                  />
                  <Text as="p" variant="bodyXs" tone="subdued">
                    Cooldown {guardrails.cooldown_minutes}m between actions on the same campaign.
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
  submitting,
  onClose,
}: {
  alert: Alert;
  kind: ActionKind;
  submitting: boolean;
  onClose: () => void;
}) {
  const idempotencyKey = useStableIdempotencyKey(alert.id, kind);
  const evidence = alert.evidence ?? {};

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
              identifiers needed to locate the alert + dedupe are submitted. */}
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="alertId" value={alert.id} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd" tone="subdued">
              {actionDescription(kind)}
            </Text>
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
                {`Execute · ${fmtMoney(alert.dollar_impact)}`}
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
    case "reduce_campaign_budget":
      return "Reduces daily budget by 30% (historical bend point). Reversible via Undo.";
    case "exclude_geo":
      return "Adds region to campaign exclusions for 7 days. Reversible via Undo.";
    case "reallocate_inventory":
      return "Transfers inventory between locations via Shopify. Reversible via Undo.";
    case "create_po_draft":
      return "Creates a draft purchase order in your supplier portal. Send manually after review. Not reversible.";
    case "snooze_alert":
      return "Suppresses this alert until the condition resolves. Calderyn re-evaluates on the next detection pass.";
  }
}
