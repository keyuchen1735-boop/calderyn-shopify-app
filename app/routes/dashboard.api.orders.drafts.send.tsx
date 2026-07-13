// app/routes/dashboard.api.orders.drafts.send.tsx
// POST { cart_id, email, address?, note? } -> sendDraftOrderInvoice (orders phase 3, Task 2).
// Validates the buyer shape at the boundary (never trusts the body); every domain failure
// (payments not ready, cart not a draft, empty draft, zero total) is a CalderynError that
// dashboardJson maps to its status/code — this route adds no error handling of its own.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { sendDraftOrderInvoice } from "~/lib/order/invoice.server";
import type { BuyerAddressInput } from "~/lib/buyer/identity.server";
import { isUuid } from "~/lib/ids";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELD_MAX = 500;
const NOTE_MAX = 500;

type AddressParse = { ok: true; value: BuyerAddressInput | undefined } | { ok: false };

function trimmedOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" ? v.trim() : undefined;
}

/** Mirrors createCheckout/sendDraftOrderInvoice's address guard: line1 is required whenever an
 *  address is supplied at all; every text field is bounded so a public-adjacent POST can't
 *  store oversized PII. */
function parseAddress(v: unknown): AddressParse {
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (typeof v !== "object" || Array.isArray(v)) return { ok: false };
  const r = v as Record<string, unknown>;

  const textFields = [r.name, r.line1, r.line2, r.city, r.region, r.postal, r.country, r.phone];
  if (textFields.some((f) => typeof f === "string" && f.length > FIELD_MAX)) return { ok: false };
  if (r.kind !== undefined && r.kind !== "shipping" && r.kind !== "billing") return { ok: false };

  const line1 = trimmedOrUndefined(r.line1) ?? "";
  if (!line1) return { ok: false };

  return {
    ok: true,
    value: {
      kind: r.kind === "billing" ? "billing" : "shipping",
      name: trimmedOrUndefined(r.name) ?? null,
      line1,
      line2: trimmedOrUndefined(r.line2) ?? null,
      city: trimmedOrUndefined(r.city) ?? null,
      region: trimmedOrUndefined(r.region) ?? null,
      postal: trimmedOrUndefined(r.postal) ?? null,
      country: trimmedOrUndefined(r.country) ?? null,
      phone: trimmedOrUndefined(r.phone) ?? null,
    },
  };
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");

  const cartId = typeof body.cart_id === "string" ? body.cart_id : "";
  if (!isUuid(cartId)) return jsonError(422, "invalid_cart_id", "cart_id must be a uuid.");

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return jsonError(422, "invalid_email", "email must be a valid address.");
  }

  const addr = parseAddress(body.address);
  if (!addr.ok) {
    return jsonError(422, "invalid_address", "address must include line1 and bounded-length fields.");
  }

  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string" || body.note.length > NOTE_MAX) {
      return jsonError(422, "invalid_note", `note must be a string of at most ${NOTE_MAX} characters.`);
    }
    note = body.note;
  }

  // Exchange-lite (Phase 4 Task 2): an optional return this invoice replaces. Validated as a uuid
  // here — the same shape guard every other id in this route gets — before it reaches
  // sendDraftOrderInvoice, which trusts it and stamps it straight into attribution.
  let exchangeForReturnId: string | null = null;
  if (body.exchange_for_return_id !== undefined && body.exchange_for_return_id !== null) {
    if (typeof body.exchange_for_return_id !== "string" || !isUuid(body.exchange_for_return_id)) {
      return jsonError(422, "invalid_exchange_for_return_id", "exchange_for_return_id must be a uuid.");
    }
    exchangeForReturnId = body.exchange_for_return_id;
  }

  return dashboardJson(async () => {
    const result = await sendDraftOrderInvoice(session.shopId, cartId, {
      email,
      address: addr.value,
      note,
      exchangeForReturnId,
    });
    return {
      order_id: result.orderId,
      confirmation_token: result.confirmationToken,
      total_cents: result.totalCents,
      currency: result.currency,
      email_sent: result.emailSent,
    };
  });
}
