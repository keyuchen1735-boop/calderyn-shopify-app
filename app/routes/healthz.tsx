import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { calderynClient } from "~/lib/calderyn.server";

// Public, unauthenticated liveness probe (for uptime monitors / load balancers).
// It exercises the data layer against an internal demo shop to confirm the
// Supabase read path is healthy, but it MUST NOT leak any shop's business data
// (alert titles, dollar impacts, ad spend, inventory counts, etc.). Report only
// liveness + a reachability boolean. Anything richer belongs behind CRON_SECRET.
const DEMO_SHOP = "calderyn-shop-tester.myshopify.com";

export const loader = async ({ request: _ }: LoaderFunctionArgs) => {
  const started = Date.now();
  let dataLayer: "reachable" | "unreachable" = "unreachable";
  let errorCode: string | null = null;

  try {
    const client = calderynClient(DEMO_SHOP);
    // Run the same read paths the app uses, but discard the payloads — we only
    // care that the queries resolve, never what they contain.
    await Promise.all([
      client.alerts.list({}),
      client.audit.list(),
      client.campaigns.list(),
      client.skus.list(),
      client.guardrails.get(),
    ]);
    dataLayer = "reachable";
  } catch (err) {
    const e = err as { code?: string };
    errorCode = e.code ?? "ERROR";
  }

  return json(
    {
      ok: dataLayer === "reachable",
      checks: { dataLayer },
      ...(errorCode ? { errorCode } : {}),
      elapsed_ms: Date.now() - started,
    },
    { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
};
