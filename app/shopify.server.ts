import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { getSupabase, provisionShop, resolveShopId } from "./lib/supabase.server";
import { enqueueShopifyBackfill, shopifyNeverSynced } from "./lib/ingest/enqueue.server";
import { resurfaceAllSnoozes } from "./lib/actions/snooze.server";

// TEMP diagnostic (remove after env investigation): logs only the LENGTH of each
// secret at runtime — never the value — so we can see which prod env vars reach
// the lambda empty. Runs before shopifyApp() validates so it fires even if init throws.
console.log(
  "[envcheck]",
  JSON.stringify({
    env: process.env.VERCEL_ENV || "?",
    APP_URL: (process.env.SHOPIFY_APP_URL || "").length,
    API_KEY: (process.env.SHOPIFY_API_KEY || "").length,
    API_SECRET: (process.env.SHOPIFY_API_SECRET || "").length,
    SCOPES: (process.env.SCOPES || "").length,
    DATABASE_URL: (process.env.DATABASE_URL || "").length,
    SUPABASE_URL: (process.env.SUPABASE_URL || "").length,
  }),
);

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  hooks: {
    afterAuth: async ({ session }) => {
      try {
        await provisionShop(session.shop);
        // Snapshot first-install state BEFORE enqueue resets sync_status.
        const firstInstall = await shopifyNeverSynced(session.shop);
        await enqueueShopifyBackfill(session.shop);
        // On first install, pull the catalog + last 30 days of orders inline so the
        // merchant sees their data immediately instead of waiting up to 30 min for
        // the /cron/ingest tick. Routine re-auths skip this; the cron keeps data
        // fresh after the initial sync. Dynamic import avoids a static import cycle
        // (backfill -> shopify-admin -> this module).
        if (firstInstall) {
          try {
            const { backfillShop } = await import("./lib/ingest/backfill.server");
            await backfillShop(session.shop);
          } catch (err) {
            // Best-effort: backfillShop marks sync_status='error' on failure, which
            // the cron skips. Reset to 'pending' so /cron/ingest still recovers the
            // data, then swallow — a backfill failure must not block install.
            console.error(`[afterAuth] inline backfill failed for ${session.shop}`, err);
            await enqueueShopifyBackfill(session.shop);
          }
        }
        // A fresh login re-surfaces alerts snoozed in a prior session (snooze
        // hides until +1 day or next login, whichever first). Kept last so it
        // can never disrupt provisioning/backfill.
        await resurfaceAllSnoozes(getSupabase(), await resolveShopId(session.shop));
      } catch (err) {
        console.error(
          `[afterAuth] failed to provision/enqueue shop ${session.shop} in Supabase`,
          err,
        );
      }
    },
  },
  distribution: AppDistribution.AppStore,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    // Shopify rejects non-expiring offline tokens for new public apps
    // (enforced 2026-04-01): background Admin API calls 403 without this.
    // The library mints expiring offline tokens and auto-refreshes them.
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
