import { type LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/response.server";
import { calderynClient } from "~/lib/calderyn.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";

// Two-mode health endpoint:
//   PUBLIC (default, unauthenticated): a SHALLOW liveness probe for uptime
//   monitors / load balancers. Returns only `{ ok: true }`. It does NOT touch
//   the data layer and discloses NO reachability/timing — an anonymous caller
//   must not be able to probe backend health or amplify load onto real queries.
//   DEEP (authenticated with CRON_SECRET): exercises the data-layer read paths
//   against an internal demo shop to confirm the Supabase read path is healthy,
//   reporting reachability + timing. Payloads are discarded; it MUST NOT leak
//   any shop's business data.
const DEMO_SHOP = "calderyn-shop-tester.myshopify.com";

const SHALLOW_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Public path: shallow probe only. Gate the deep checks behind CRON_SECRET
  // using the same bearer convention as the cron routes (cron.detect.tsx:9).
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return json({ ok: true }, { headers: SHALLOW_HEADERS });
  }

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
    { headers: SHALLOW_HEADERS },
  );
};
