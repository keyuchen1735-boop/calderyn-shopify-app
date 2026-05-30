import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { CalderynError, calderynClient } from "~/lib/calderyn.server";
import { markShopUninstalled } from "~/lib/supabase.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  try {
    await markShopUninstalled(shop);
  } catch (err) {
    console.error(`Failed to mark shop ${shop} uninstalled in Supabase`, err);
  }

  try {
    await calderynClient(shop).internal.forwardWebhook(
      "/internal/shops/uninstall",
      { shop },
      { "X-Shopify-Topic": topic },
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
