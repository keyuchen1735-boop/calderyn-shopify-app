import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  handleCarrierRateCallback,
  resolveCarrierShopByToken,
} from "~/lib/shipping/carrier-service.server";

// Public, unauthenticated CarrierService rate callback (#6.4). NOT behind
// authenticate.admin — Shopify POSTs here from a buyer's checkout. Shopify does
// NOT HMAC-sign these callbacks, so the high-entropy per-shop token in the URL
// path is the authenticator: an unknown token is rejected fail-closed (401, no
// rates leaked). All quoting/auth lives in carrier-service.server.ts so it is
// unit-tested without HTTP.
// TODO: M3 — scrub the path token from access/proxy logs (infra log config); the
// token is a bearer secret and must not be persisted in request logs.
const JSON_HEADERS = { "content-type": "application/json" };
const EMPTY_RATES = JSON.stringify({ rates: [] });

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  // Authenticate BEFORE buffering the body so an unauthenticated caller can't force
  // full request-body buffering pre-auth (M2). Unknown token -> 401, body unread.
  const token = params.token ?? "";
  const shop = await resolveCarrierShopByToken(token);
  if (!shop) return new Response(EMPTY_RATES, { status: 401, headers: JSON_HEADERS });

  const rawBody = await request.text();
  const { status, body } = await handleCarrierRateCallback(token, rawBody, {
    resolveShop: async () => shop, // already resolved above — avoid a second lookup
  });
  return new Response(body, { status, headers: JSON_HEADERS });
}

// Some Shopify flows GET the callback URL to verify reachability. Token-gated so a
// probe can't enumerate connected shops; returns an empty (valid) rate set.
export async function loader({ params }: LoaderFunctionArgs) {
  const shop = await resolveCarrierShopByToken(params.token ?? "");
  if (!shop) return new Response("Unauthorized", { status: 401 });
  return new Response(EMPTY_RATES, { status: 200, headers: JSON_HEADERS });
}
