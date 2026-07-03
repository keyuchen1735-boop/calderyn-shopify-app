import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Modal,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import type { CalderynError } from "~/lib/calderyn.server";
import { executeRefundAction } from "~/lib/actions/refund.server";
import { loadOrdersPage } from "~/lib/order/list.server";
import type { OrderRow } from "~/lib/order/list-types";
import { getSupabase, resolveShopId } from "~/lib/supabase.server";
import { useActionToast, type ActionToast } from "~/lib/toast";
import { fmtMoney } from "~/lib/format";

type LoaderPayload = {
  orders: OrderRow[];
  error: { code: string; message: string } | null;
};

export type RefundPayload = ActionToast & {
  error?: { code: string; message: string };
};

// Owned orders that captured money can be refunded (mirrors REFUNDABLE_STATES in refund.server.ts).
const REFUNDABLE_STATES = new Set(["paid", "fulfilled", "partially_refunded"]);

const STATE_LABEL: Record<string, string> = {
  paid: "Paid",
  fulfilled: "Fulfilled",
  checkout_pending: "Checkout pending",
  cancelled: "Cancelled",
  refunded: "Refunded",
  partially_refunded: "Partially refunded",
  cart: "Cart",
};

function stateTone(state: string): "success" | "attention" | "info" {
  if (state === "paid" || state === "fulfilled") return "success";
  if (state === "refunded" || state === "partially_refunded") return "attention";
  return "info";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  try {
    const shopId = await resolveShopId(session.shop);
    const { orders } = await loadOrdersPage(shopId);
    return json<LoaderPayload>({ orders, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({ orders: [], error: { code: e.code ?? "ERROR", message: e.message } });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  // Boundary validation — never trust the modal's FormData (repo rule).
  const orderId = String(formData.get("order_id") ?? "").trim();
  const idempotencyKey = String(formData.get("idempotency_key") ?? "").trim();
  const amountRaw = String(formData.get("amount_cents") ?? "").trim();

  if (!orderId || !idempotencyKey) {
    return json<RefundPayload>(
      { ok: false, toast: { message: "Missing order or request key.", isError: true } },
      { status: 422 },
    );
  }
  let amountCents: number | undefined;
  if (amountRaw) {
    if (!/^\d+$/.test(amountRaw) || Number(amountRaw) <= 0) {
      return json<RefundPayload>(
        { ok: false, toast: { message: "Refund amount must be a positive whole number of cents.", isError: true } },
        { status: 422 },
      );
    }
    amountCents = Number(amountRaw);
  }

  try {
    const shopId = await resolveShopId(session.shop);
    const result = await executeRefundAction(
      shopId,
      { orderId, amountCents, idempotencyKey, actor: "merchant" },
      getSupabase(),
    );
    return json<RefundPayload>({
      ok: true,
      toast: {
        message: `Refunded ${fmtMoney(result.amountCents)} — order is now ${STATE_LABEL[result.orderState] ?? result.orderState}.`,
      },
    });
  } catch (err) {
    const e = err as CalderynError;
    const message = e?.message ?? "Refund failed.";
    return json<RefundPayload>(
      { ok: false, error: { code: e?.code ?? "ERROR", message }, toast: { message, isError: true } },
      { status: e?.status ?? 500 },
    );
  }
};

export default function OrdersRoute() {
  const { orders, error } = useLoaderData<LoaderPayload>();
  const fetcher = useFetcher<RefundPayload>();
  useActionToast(fetcher.data);

  const [active, setActive] = useState<OrderRow | null>(null);
  const [mode, setMode] = useState<"full" | "partial">("full");
  const [dollars, setDollars] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const submitting = fetcher.state !== "idle";

  // Close the modal + re-mint the idempotency key once a submit succeeds.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      setActive(null);
      setIdempotencyKey(crypto.randomUUID());
    }
  }, [fetcher.state, fetcher.data]);

  const openRefund = (order: OrderRow) => {
    setActive(order);
    setMode("full");
    setDollars("");
    setIdempotencyKey(crypto.randomUUID());
  };

  const partialCents = Math.round(Number(dollars) * 100);
  const invalidPartial =
    mode === "partial" &&
    (!Number.isFinite(partialCents) || partialCents <= 0 || (active != null && partialCents > active.totalCents));

  const submit = () => {
    if (!active) return;
    fetcher.submit(
      {
        order_id: active.id,
        idempotency_key: idempotencyKey,
        ...(mode === "partial" ? { amount_cents: String(partialCents) } : {}),
      },
      { method: "post" },
    );
  };

  return (
    <Page title="Orders">
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" title="Couldn't load orders">
            <p>{error.message}</p>
          </Banner>
        )}
        <Card padding="0">
          {orders.length === 0 ? (
            <Box padding="400">
              <Text as="p" tone="subdued">
                No orders yet. Orders placed through your storefront or the agentic channel appear here.
              </Text>
            </Box>
          ) : (
            <BlockStack gap="0">
              {orders.map((o) => (
                <Box key={o.id} padding="300" borderBlockEndWidth="025" borderColor="border">
                  <InlineStack align="space-between" blockAlign="center" gap="400">
                    <BlockStack gap="050">
                      <Text as="span" fontWeight="semibold">
                        {o.ref}
                      </Text>
                      <Text as="span" tone="subdued" variant="bodySm">
                        {o.buyerEmail ?? "Guest"} · {fmtMoney(o.totalCents)}
                      </Text>
                    </BlockStack>
                    <InlineStack gap="300" blockAlign="center">
                      <Badge tone={stateTone(o.state)}>{STATE_LABEL[o.state] ?? o.state}</Badge>
                      {REFUNDABLE_STATES.has(o.state) && (
                        <Button onClick={() => openRefund(o)}>Refund</Button>
                      )}
                    </InlineStack>
                  </InlineStack>
                </Box>
              ))}
            </BlockStack>
          )}
        </Card>
      </BlockStack>

      {active && (
        <Modal
          open
          onClose={() => setActive(null)}
          title={`Refund ${active.ref}`}
          primaryAction={{
            content: submitting ? "Refunding…" : "Issue refund",
            onAction: submit,
            loading: submitting,
            disabled: submitting || invalidPartial,
            destructive: true,
          }}
          secondaryActions={[{ content: "Cancel", onAction: () => setActive(null), disabled: submitting }]}
        >
          <Modal.Section>
            <BlockStack gap="300">
              <Text as="p" tone="subdued">
                Order total {fmtMoney(active.totalCents)}. A refund is sent back through Stripe and cannot be undone.
              </Text>
              <Select
                label="Amount"
                options={[
                  { label: `Full refund (${fmtMoney(active.totalCents)})`, value: "full" },
                  { label: "Partial refund", value: "partial" },
                ]}
                value={mode}
                onChange={(v) => setMode(v as "full" | "partial")}
              />
              {mode === "partial" && (
                <TextField
                  label="Partial amount (USD)"
                  type="number"
                  autoComplete="off"
                  value={dollars}
                  onChange={setDollars}
                  min={0}
                  step={0.01}
                  prefix="$"
                  error={invalidPartial ? "Enter an amount between $0 and the order total." : undefined}
                />
              )}
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}
