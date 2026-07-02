import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { CalderynError, calderynClient } from "~/lib/calderyn.server";
import { markShopUninstalled, resolveShopId } from "~/lib/supabase.server";
import { revokeAllSessionsForShop } from "~/lib/dashboard/session.server";
import { deactivateCarrierService } from "~/lib/shipping/carrier-service.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // No `if (session)` guard: on uninstall the offline session is often already
  // invalid, so authenticate.webhook returns session=null — exactly the case
  // where stale rows must still be purged. deleteMany is a no-op on zero rows.
  await db.session.deleteMany({ where: { shop } });

  try {
    await markShopUninstalled(shop);
  } catch (err) {
    console.error(`Failed to mark shop ${shop} uninstalled in Supabase`, err);
    // uninstalled_at drives the 30-day GDPR redaction sweep — if this write is
    // lost the shop is never purged. Non-2xx → Shopify retries the delivery;
    // everything in this handler is idempotent on replay.
    return new Response(null, { status: 500 });
  }

  try {
    await revokeAllSessionsForShop(shop);
  } catch (err) {
    console.error(`Failed to revoke dashboard sessions for ${shop}`, err);
  }

  // Deactivate the CarrierService registration (#6.4). Shopify drops the carrier
  // service on uninstall; flipping our row to inactive makes the rate callback
  // reject fail-closed (401) before reinstall re-registers. Best-effort + idempotent.
  try {
    await deactivateCarrierService(await resolveShopId(shop));
  } catch (err) {
    console.error(`Failed to deactivate CarrierService for ${shop}`, err);
  }

  try {
    await calderynClient(shop).internal.forwardWebhook(
      "/internal/shops/uninstall",
      { shop },
      { "X-Shopify-Topic": topic, "X-Shopify-Webhook-Id": webhookId },
    );
  } catch (err) {
    if (err instanceof CalderynError) {
      console.error(
        `Failed to notify Calderyn backend of uninstall for ${shop}: ${err.code} ${err.message}`,
      );
    } else {
      console.error(`Failed to notify Calderyn backend of uninstall for ${shop}`, err);
    }
  }

  return new Response();
};
