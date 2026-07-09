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
import { getAcpSession, claimAcpSessionForCompletion, completeAcpSession, releaseAcpSessionClaim } from "~/lib/commerce/acp/session-store.server";
import { getQuote } from "~/lib/commerce/quote-store.server";
import { assertWithinCommerceCap } from "~/lib/commerce/guardrail.server";
import { placeAgenticOrder, OutOfStockError, type PlaceResult } from "~/lib/commerce/order.server";
import { chargeSharedPaymentToken } from "~/lib/commerce/acp/charge.server";
import { isSupportedCurrency } from "~/lib/payments/stripe.server";
import { paymentsReadiness } from "~/lib/payments/connect.server";
import { PaymentsNotReadyError } from "~/lib/payments/errors";

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
  // Reject an unchargeable currency BEFORE claiming/placing (mirrors the storefront
  // guard in createCheckout). Otherwise placeAgenticOrder writes the order rows and
  // Stripe rejects the charge afterward, orphaning the order and wedging the session.
  if (!isSupportedCurrency(q.currency)) {
    return json({ error: "unsupported_currency" }, { status: 400 });
  }
  // Reject an unpayable shop BEFORE claiming/placing (same pattern as the currency
  // guard): the charge path fails CLOSED for a shop without a fully-enabled Stripe
  // account, so gating here avoids writing an order that can never be charged and
  // wedging the session. 503 = retryable once the merchant finishes onboarding.
  if (!(await paymentsReadiness(s.shopId)).ready) {
    return json({ error: "payments_not_ready" }, { status: 503 });
  }

  let body: AcpCompleteBody;
  try {
    body = JSON.parse(raw) as AcpCompleteBody;
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body?.buyer?.email || !body?.payment?.shared_payment_token) {
    return json({ error: "invalid_body" }, { status: 400 });
  }

  // Atomically claim the session BEFORE any place/charge. A retried or concurrent
  // `complete` that loses this claim must not re-place and re-charge (double charge).
  const claimed = await claimAcpSessionForCompletion(s.sessionId);
  if (!claimed) {
    const cur = await getAcpSession(String(params.id));
    if (cur?.status === "completed" && cur.orderId) {
      return json({ order_id: cur.orderId, status: "completed" });
    }
    return json({ error: "in_progress" }, { status: 409 });
  }

  // Rule 5: deterministic cap check BEFORE any charge — model never decides the spend authority.
  // Cap + place run before any money moves, so a failure here is safe to recover: release the
  // claim (completing -> open) so a transient blip is retryable instead of permanently wedging
  // the session. Past the charge below, money may have moved and placeAgenticOrder is not
  // idempotent, so we must NOT reopen — a stuck `completing` is the lesser evil than a double charge.
  let placed: PlaceResult;
  try {
    await assertWithinCommerceCap(s.clientId, q.totalCents);
    placed = await placeAgenticOrder(
      s.shopId,
      s.quoteId,
      { email: body.buyer.email, phone: body.buyer.phone ?? null },
      { protocol: "acp", clientId: s.clientId },
    );
  } catch (err) {
    await releaseAcpSessionClaim(s.sessionId);
    // One or more tracked lines sold out between quote and completion (mirrors the storefront
    // checkout route's OutOfStockError -> 409 mapping): actionable for the caller instead of an
    // opaque 500, and the claim above is already released so a retry with a fresh quote works.
    if (err instanceof OutOfStockError) return json({ error: "OUT_OF_STOCK" }, { status: 409 });
    throw err;
  }
  try {
    await chargeSharedPaymentToken(s.shopId, {
      orderId: placed.orderId,
      totalCents: placed.totalCents,
      currency: placed.currency,
      sharedPaymentToken: body.payment.shared_payment_token,
    });
  } catch (err) {
    // PaymentsNotReadyError is thrown strictly BEFORE any Stripe call (routing decision
    // or destination-param 400 — pre-authorization), so no money has moved and releasing
    // the claim is provably safe: the retry-after-onboarding path stays open instead of
    // wedging the session in `completing`. Any other charge error keeps the deliberate
    // stuck-claim posture — money may have moved, and a double charge is the worse evil.
    if (err instanceof PaymentsNotReadyError) {
      await releaseAcpSessionClaim(s.sessionId);
      return json({ error: "payments_not_ready" }, { status: 503 });
    }
    throw err;
  }
  await completeAcpSession(s.sessionId, placed.orderId);
  // The order reaches `paid` via the existing Stripe webhook on payment_intent.succeeded.
  return json({ order_id: placed.orderId, status: "completed", total: placed.totalCents, currency: placed.currency });
}
