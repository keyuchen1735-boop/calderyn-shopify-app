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

// A failure in a fire-and-forget background task — e.g. the session-store table
// poll the Prisma session storage starts in its constructor, which rejects if
// the database is briefly unreachable on a cold start — must NOT crash the whole
// serverless function and 500 every route (including static assets). Node exits
// the process on an unhandled rejection by default; install a guard once so such
// failures are logged and the app keeps serving.
const g = globalThis as unknown as { __cdProcessGuards?: boolean };
if (!g.__cdProcessGuards) {
  g.__cdProcessGuards = true;
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err);
  });
}

// The Shopify SDK validates config synchronously at construction and throws if
// apiKey or appUrl is blank — and this module is imported by the server entry,
// so a blank value would crash the entire bundle at boot (every route 500s,
// including static assets). Fall back to the known PUBLIC values (the client ID
// is shipped to the browser via App Bridge; the app URL is public) so a missing
// env never takes the app down. The API secret stays env-only.
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY || "508429753f1e60bd48c4dadbe063a27e",
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "https://app.calderyncompany.com",
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
