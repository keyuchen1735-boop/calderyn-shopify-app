// ACP checkout_sessions — POST create. Dormant unless ACP_ENABLED=true.
// Accepts a line-items + address body from the ChatGPT agent, quotes, locks, creates session.
// Confirm exact wire field names against the onboarded ACP spec version before enabling.
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { verifyAcpSignature } from "~/lib/commerce/acp/signature.server";
import { quoteCart } from "~/lib/commerce/quote.server";
import { lockQuote, getQuote } from "~/lib/commerce/quote-store.server";
import { createAcpSession } from "~/lib/commerce/acp/session-store.server";
import { toAcpSessionBody } from "~/lib/commerce/acp/map";
import { sha256hex } from "~/lib/mcp_oauth.server";

interface AcpCreateBody {
  shop_key: string;
  client_id: string;
  line_items: Array<{ id: string; quantity: number }>;
  fulfillment_address: {
    line_1: string;
    line_2?: string;
    city: string;
    state: string;
    postal_code: string;
    country: string;
  };
}

export async function action({ request }: ActionFunctionArgs) {
  if (process.env.ACP_ENABLED !== "true") return json({ error: "acp_disabled" }, { status: 404 });
  const raw = await request.text();
  if (!verifyAcpSignature(raw, request.headers.get("signature") ?? "", process.env.ACP_SIGNING_SECRET ?? "")) {
    return json({ error: "bad_signature" }, { status: 401 });
  }
  const body = JSON.parse(raw) as AcpCreateBody;
  const shopId = resolveShop(body.shop_key);
  const dest = {
    street1: body.fulfillment_address.line_1,
    street2: body.fulfillment_address.line_2,
    city: body.fulfillment_address.city,
    state: body.fulfillment_address.state,
    zip: body.fulfillment_address.postal_code,
    country: body.fulfillment_address.country,
  };
  const quote = await quoteCart(shopId, body.line_items.map((l) => ({ variantId: l.id, quantity: l.quantity })), dest);
  const locked = await lockQuote(shopId, quote, { clientId: body.client_id, destinationHash: sha256hex(JSON.stringify(dest)) });
  const sessionId = await createAcpSession(shopId, body.client_id, locked.quoteId);
  const full = await getQuote(shopId, locked.quoteId);
  return json(toAcpSessionBody(sessionId, full!));
}

// TODO-REPLACE before ACP onboarding: resolve shop_key (the per-merchant key issued at
// onboarding) to the shop_id uuid via the registry. UNREACHABLE while ACP_ENABLED is false.
function resolveShop(shopKey: string): string {
  return shopKey; // TODO-REPLACE: key->shop_id uuid lookup
}
