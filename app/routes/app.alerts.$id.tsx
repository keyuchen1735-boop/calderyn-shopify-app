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
  Box,
  Banner,
  Button,
  Card,
  InlineGrid,
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
  DETECTOR_LABELS,
  DETECTOR_TO_ACTIONS,
} from "~/lib/labels";
import { useActionToast } from "~/lib/toast";
import { resolveActionParam } from "~/lib/assistant/action-param";
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

  const params_: Record<string, unknown> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("param_")) {
      params_[k.slice(6)] = typeof v === "string" ? v : null;
    }
  }

  try {
    if (kind === "reallocate_inventory") {
      const inventoryItemId = String(formData.get("param_inventory_item_id") || "");
      const fromLocationId = String(formData.get("param_from_location_id") || "");
      const toLocationId = String(formData.get("param_to_location_id") || "");
      const delta = Number(formData.get("param_delta") || 0);

      if (!inventoryItemId || !fromLocationId || !toLocationId || !delta) {
        throw new CalderynError({
          code: "INVALID_INVENTORY_PARAMS",
          status: 400,
          message:
            "reallocate_inventory requires inventory_item_id, from_location_id, to_location_id, and delta",
        });
      }

      const { operationId } = await inventoryAdjustQuantities(admin, {
        inventoryItemId,
        fromLocationId,
        toLocationId,
        delta,
      });

      await client.actions.execute({
        alertId,
        kind,
        params: {
          ...params_,
          shopify_operation_id: operationId,
        },
        idempotencyKey,
      });
    } else {
      await client.actions.execute({
        alertId,
        kind,
        params: params_,
        idempotencyKey,
      });
    }

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
          <Badge
            tone={
              alert.severity === "critical"
                ? "critical"
                : alert.severity === "high"
                  ? "warning"
                  : "attention"
            }
          >
            {alert.severity}
          </Badge>
          <Badge>{DETECTOR_LABELS[alert.detector_id]}</Badge>
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
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingSm">
                    Claude&apos;s read
                  </Text>
                  <Badge>{`Rank #${alert.claude_rank}`}</Badge>
                </InlineStack>
                <Text as="p" variant="bodyLg">
                  {alert.narrative}
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingSm">
                  Evidence
                </Text>
                <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                  {Object.entries(evidence).map(([k, v]) => (
                    <Box
                      key={k}
                      padding="300"
                      background="bg-surface-secondary"
                      borderRadius="200"
                    >
                      <BlockStack gap="100">
                        <Text as="p" variant="bodySm" tone="subdued">
                          {k.replace(/_/g, " ")}
                        </Text>
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          {typeof v === "object" ? JSON.stringify(v) : String(v)}
                        </Text>
                      </BlockStack>
                    </Box>
                  ))}
                </InlineGrid>
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
                <BlockStack gap="200">
                  {allowedActions.map((kind, i) => (
                    <Button
                      key={kind}
                      variant={i === 0 ? "primary" : undefined}
                      onClick={() => setActionKind(kind)}
                      fullWidth
                    >
                      {ACTION_LABELS[kind]}
                    </Button>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>

            {guardrails && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingSm">
                    Guardrails
                  </Text>
                  <BlockStack gap="100">
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodySm" tone="subdued">
                        Daily budget remaining
                      </Text>
                      <Text as="span" variant="bodySm" fontWeight="semibold">
                        {fmtMoney(
                          guardrails.daily_action_budget_cents -
                            guardrails.daily_action_budget_used_cents,
                        )}
                      </Text>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodySm" tone="subdued">
                        Per-action cap
                      </Text>
                      <Text as="span" variant="bodySm" fontWeight="semibold">
                        {fmtMoney(guardrails.dollar_cap_cents)}
                      </Text>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodySm" tone="subdued">
                        Cooldown
                      </Text>
                      <Text as="span" variant="bodySm" fontWeight="semibold">
                        {guardrails.cooldown_minutes}m
                      </Text>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodySm" tone="subdued">
                        Business hours
                      </Text>
                      <Text as="span" variant="bodySm" fontWeight="semibold">
                        {guardrails.business_hours.start}–{guardrails.business_hours.end}
                      </Text>
                    </InlineStack>
                  </BlockStack>
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
  const target =
    kind === "pause_campaign" || kind === "reduce_campaign_budget" || kind === "exclude_geo"
      ? alert.campaign || "Campaign"
      : alert.sku
        ? `${alert.sku}`
        : "Action";

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
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="alertId" value={alert.id} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <input type="hidden" name="param_target" value={target} />
          <input type="hidden" name="param_estimate_cents" value={String(alert.dollar_impact)} />
          {inventoryHints && (
            <>
              <input
                type="hidden"
                name="param_inventory_item_id"
                value={inventoryHints.inventoryItemId}
              />
              <input
                type="hidden"
                name="param_from_location_id"
                value={inventoryHints.fromLocationId}
              />
              <input
                type="hidden"
                name="param_to_location_id"
                value={inventoryHints.toLocationId}
              />
              <input type="hidden" name="param_delta" value={inventoryHints.delta} />
            </>
          )}
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
