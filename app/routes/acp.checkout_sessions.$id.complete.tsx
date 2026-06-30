// ACP checkout_sessions/$id/complete — POST. Dormant unless ACP_ENABLED=true.
// Order of operations is the invariant (rule 5):
//   verify signature → cap → place → charge → complete-session
// Never reorder. The integration test asserts this ordering.
// Confirm exact wire field names (shared_payment_token, buyer fields) against the onboarded ACP
// spec version before enabling. The charge path (SPT via Stripe) must also match the Stripe ACP
// integration mode enabled during onboarding.
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { verifyAcpSignature } from "~/lib/commerce/acp/signature.server";
import { getAcpSession, completeAcpSession } from "~/lib/commerce/acp/session-store.server";
import { getQuote } from "~/lib/commerce/quote-store.server";
import { assertWithinCommerceCap } from "~/lib/commerce/guardrail.server";
import { placeAgenticOrder } from "~/lib/commerce/order.server";
import { chargeSharedPaymentToken } from "~/lib/commerce/acp/charge.server";

interface AcpCompleteBody {
  payment: { shared_payment_token: string };
  buyer: { email: string; phone?: string };
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (process.env.ACP_ENABLED !== "true") return json({ error: "acp_disabled" }, { status: 404 });
  const raw = await request.text();
  if (!verifyAcpSignature(raw, request.headers.get("signature") ?? "", process.env.ACP_SIGNING_SECRET ?? "")) {
    return json({ error: "bad_signature" }, { status: 401 });
  }

  const s = await getAcpSession(String(params.id));
  if (!s?.quoteId) return json({ error: "not_found" }, { status: 404 });
  // Idempotent: already completed orders return the same result without re-charging
  if (s.status === "completed" && s.orderId) {
    return json({ order_id: s.orderId, status: "completed" });
  }

  const q = await getQuote(s.shopId, s.quoteId);
  if (!q) return json({ error: "QUOTE_EXPIRED" }, { status: 409 });

  const body = JSON.parse(raw) as AcpCompleteBody;

  // Rule 5: deterministic cap check BEFORE any charge — model never decides the spend authority
  await assertWithinCommerceCap(s.clientId, q.totalCents);
  const placed = await placeAgenticOrder(
    s.shopId,
    s.quoteId,
    { email: body.buyer.email, phone: body.buyer.phone ?? null },
    { protocol: "acp", clientId: s.clientId },
  );
  await chargeSharedPaymentToken(s.shopId, {
    orderId: placed.orderId,
    totalCents: placed.totalCents,
    currency: placed.currency,
    sharedPaymentToken: body.payment.shared_payment_token,
  });
  await completeAcpSession(s.sessionId, placed.orderId);
  // The order reaches `paid` via the existing Stripe webhook on payment_intent.succeeded.
  return json({ order_id: placed.orderId, status: "completed", total: placed.totalCents, currency: placed.currency });
}
