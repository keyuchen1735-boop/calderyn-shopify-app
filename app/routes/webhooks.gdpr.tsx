import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { CalderynError, calderynClient } from "~/lib/calderyn.server";

const TOPIC_TO_PATH: Record<string, string> = {
  "customers/data_request": "/internal/gdpr/data_request",
  "customers/redact": "/internal/gdpr/customers_redact",
  "shop/redact": "/internal/gdpr/shop_redact",
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, webhookId } = await authenticate.webhook(request);
  // Topic only — no shop domain in GDPR-path logs (data-minimization; the
  // forward below carries the full context to the engine).
  console.log(`[webhooks.gdpr] received ${topic}`);

  const path = TOPIC_TO_PATH[topic];
  if (!path) {
    console.warn(`Unknown GDPR topic: ${topic}`);
    return new Response();
  }

  try {
    await calderynClient(shop).internal.forwardWebhook(
      path,
      payload,
      // Delivery id keys the unique(webhook_id) dedup — retries are safe.
      { "X-Shopify-Topic": topic, "X-Shopify-Webhook-Id": webhookId },
    );
  } catch (err) {
    if (err instanceof CalderynError) {
      console.error(
        `Failed to forward GDPR webhook ${topic} for ${shop}: ${err.code} ${err.message}`,
      );
    } else {
      console.error(`Failed to forward GDPR webhook ${topic} for ${shop}`, err);
    }
    // A dropped customers/redact or data_request is a compliance miss, not a
    // log line. Non-2xx → Shopify redelivers until the forward lands.
    return new Response(null, { status: 500 });
  }

  return new Response();
};
