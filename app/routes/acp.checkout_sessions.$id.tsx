// ACP checkout_sessions/$id — POST update / GET retrieve. Dormant unless ACP_ENABLED=true.
// Update re-quotes with new line-items/address and refreshes the locked quote on the session.
// Confirm exact wire field names against the onboarded ACP spec version before enabling.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/response.server";
import { verifyAcpSignature } from "~/lib/commerce/acp/signature.server";
import { getAcpSession, updateAcpSessionQuote } from "~/lib/commerce/acp/session-store.server";
import { getQuote, lockQuote } from "~/lib/commerce/quote-store.server";
import { quoteCart } from "~/lib/commerce/quote.server";
import { toAcpSessionBody } from "~/lib/commerce/acp/map";
import { sha256hex } from "~/lib/mcp_oauth.server";

interface AcpUpdateBody {
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

export async function loader({ params }: LoaderFunctionArgs) {
  if (process.env.ACP_ENABLED !== "true") return json({ error: "acp_disabled" }, { status: 404 });
  const s = await getAcpSession(String(params.id));
  if (!s?.quoteId) return json({ error: "not_found" }, { status: 404 });
  const q = await getQuote(s.shopId, s.quoteId);
  if (!q) return json({ error: "expired" }, { status: 409 });
  return json(toAcpSessionBody(s.sessionId, q));
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (process.env.ACP_ENABLED !== "true") return json({ error: "acp_disabled" }, { status: 404 });
  const raw = await request.text();
  if (!verifyAcpSignature(raw, request.headers.get("signature") ?? "", process.env.ACP_SIGNING_SECRET ?? "")) {
    return json({ error: "bad_signature" }, { status: 401 });
  }
  const s = await getAcpSession(String(params.id));
  if (!s) return json({ error: "not_found" }, { status: 404 });
  const body = JSON.parse(raw) as AcpUpdateBody;
  const dest = {
    street1: body.fulfillment_address.line_1,
    street2: body.fulfillment_address.line_2,
    city: body.fulfillment_address.city,
    state: body.fulfillment_address.state,
    zip: body.fulfillment_address.postal_code,
    country: body.fulfillment_address.country,
  };
  const quote = await quoteCart(s.shopId, body.line_items.map((l) => ({ variantId: l.id, quantity: l.quantity })), dest);
  const locked = await lockQuote(s.shopId, quote, { clientId: s.clientId, destinationHash: sha256hex(JSON.stringify(dest)) });
  await updateAcpSessionQuote(s.sessionId, locked.quoteId);
  const full = await getQuote(s.shopId, locked.quoteId);
  return json(toAcpSessionBody(s.sessionId, full!));
}
