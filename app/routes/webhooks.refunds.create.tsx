import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { CalderynError, calderynClient } from "~/lib/calderyn.server";
import { minimizeRefundWebhook } from "~/lib/ingest/mappers.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, webhookId } = await authenticate.webhook(request);
  try {
    // Strip transactions/notes before storing — the transform worker only needs
    // the refunded lines (product + quantity + amount) to build refund_fact.
    const minimal = minimizeRefundWebhook(payload as Record<string, unknown>);
    await calderynClient(shop).internal.forwardWebhook(
      "/internal/webhooks/shopify/refunds_create",
      minimal,
      // Delivery id keys the unique(webhook_id) dedup — retries are safe.
      { "X-Shopify-Topic": topic, "X-Shopify-Webhook-Id": webhookId },
    );
  } catch (err) {
    if (err instanceof CalderynError) {
      console.error(`Failed to forward refunds/create for ${shop}: ${err.code} ${err.message}`);
    } else {
      console.error(`Failed to forward refunds/create for ${shop}`, err);
    }
    // Non-2xx → Shopify redelivers rather than the refund being lost.
    return new Response(null, { status: 500 });
  }
  return new Response();
};
