import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { CalderynError, calderynClient } from "~/lib/calderyn.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, webhookId } = await authenticate.webhook(request);
  try {
    await calderynClient(shop).internal.forwardWebhook(
      "/internal/webhooks/shopify/products_update",
      payload,
      // Delivery id keys the unique(webhook_id) dedup — retries are safe.
      { "X-Shopify-Topic": topic, "X-Shopify-Webhook-Id": webhookId },
    );
  } catch (err) {
    if (err instanceof CalderynError) {
      console.error(
        `Failed to forward products/update for ${shop}: ${err.code} ${err.message}`,
      );
    } else {
      console.error(`Failed to forward products/update for ${shop}`, err);
    }
    // Non-2xx → Shopify redelivers rather than the update being lost.
    return new Response(null, { status: 500 });
  }
  return new Response();
};
