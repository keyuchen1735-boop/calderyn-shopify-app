import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { CalderynError, calderynClient } from "~/lib/calderyn.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  try {
    await calderynClient(shop).internal.forwardWebhook(
      "/internal/webhooks/shopify/inventory_levels_update",
      payload,
      { "X-Shopify-Topic": topic },
    );
  } catch (err) {
    if (err instanceof CalderynError) {
      console.error(
        `Failed to forward inventory_levels/update for ${shop}: ${err.code} ${err.message}`,
      );
    } else {
      console.error(`Failed to forward inventory_levels/update for ${shop}`, err);
    }
  }
  return new Response();
};
