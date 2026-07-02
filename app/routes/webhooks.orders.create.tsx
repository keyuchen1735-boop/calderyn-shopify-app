import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { CalderynError, calderynClient } from "~/lib/calderyn.server";
import { minimizeOrderWebhook } from "~/lib/ingest/mappers.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, webhookId } = await authenticate.webhook(request);
  try {
    // Store only the order fields the pipeline uses — never the customer PII
    // (name/email/phone/addresses) Shopify includes on this webhook.
    const minimal = minimizeOrderWebhook(payload as Record<string, unknown>);
    await calderynClient(shop).internal.forwardWebhook(
      "/internal/webhooks/shopify/orders_create",
      minimal,
      // Shopify's delivery id keys the unique(webhook_id) dedup, so the 500
      // below can safely trigger a redelivery without double-counting revenue.
      { "X-Shopify-Topic": topic, "X-Shopify-Webhook-Id": webhookId },
    );
  } catch (err) {
    if (err instanceof CalderynError) {
      console.error(`Failed to forward orders/create for ${shop}: ${err.code} ${err.message}`);
    } else {
      console.error(`Failed to forward orders/create for ${shop}`, err);
    }
    // Non-2xx → Shopify retries the delivery; an unforwarded order is lost
    // revenue data, not something to swallow.
    return new Response(null, { status: 500 });
  }
  return new Response();
};
