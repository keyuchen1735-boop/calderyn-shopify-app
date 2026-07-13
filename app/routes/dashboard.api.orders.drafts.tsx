// app/routes/dashboard.api.orders.drafts.tsx
// Merchant-draft cart CRUD (orders phase 3, Task 2): GET lists every open merchant-draft cart
// for the session's shop; POST creates one (no cart_id) or replaces its lines (cart_id given);
// DELETE ?id= removes one outright. Same requireSameOrigin + parseJsonObjectBody + dashboardJson
// convention as dashboard.api.orders.views.tsx.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import {
  listMerchantDrafts,
  createMerchantDraft,
  replaceMerchantDraftLines,
  deleteMerchantDraft,
  type MerchantDraftLineInput,
  type MerchantDraftVM,
} from "~/lib/order/merchant-drafts.server";
import { VariantUnavailableError } from "~/lib/order/cart.server";
import { isUuid } from "~/lib/ids";

const MIN_LINES = 1;
const MAX_LINES = 50;
const MAX_QTY = 999;

function parseLines(v: unknown): MerchantDraftLineInput[] | null {
  if (!Array.isArray(v) || v.length < MIN_LINES || v.length > MAX_LINES) return null;
  const out: MerchantDraftLineInput[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) return null;
    const r = item as Record<string, unknown>;
    if (typeof r.variant_id !== "string" || !r.variant_id) return null;
    const quantity = Number(r.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) return null;
    out.push({ variantId: r.variant_id, quantity });
  }
  return out;
}

function mapDraftWire(draft: MerchantDraftVM) {
  return {
    id: draft.id,
    lines: draft.lines.map((l) => ({
      id: l.id,
      variant_id: l.variantId,
      title: l.title,
      quantity: l.quantity,
      unit_price_cents: l.unitPriceCents,
      currency: l.currency,
    })),
    subtotal_cents: draft.subtotalCents,
    currency: draft.currency,
    created_at: draft.createdAt,
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({
    drafts: (await listMerchantDrafts(session.shopId)).map(mapDraftWire),
  }));
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);

  if (request.method === "DELETE") {
    const id = new URL(request.url).searchParams.get("id") ?? "";
    if (!isUuid(id)) return jsonError(422, "invalid_id", "id must be a uuid.");
    return dashboardJson(async () => {
      await deleteMerchantDraft(session.shopId, id);
      return { deleted: true };
    });
  }

  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");

  const lines = parseLines(body.lines);
  if (!lines) {
    return jsonError(
      422,
      "invalid_lines",
      `lines must be ${MIN_LINES}-${MAX_LINES} entries of {variant_id, quantity 1-${MAX_QTY}}.`,
    );
  }
  const cartId = typeof body.cart_id === "string" && body.cart_id ? body.cart_id : null;
  if (cartId && !isUuid(cartId)) return jsonError(422, "invalid_cart_id", "cart_id must be a uuid.");

  return dashboardJson(async () => {
    try {
      const draft = cartId
        ? await replaceMerchantDraftLines(session.shopId, cartId, lines)
        : await createMerchantDraft(session.shopId, lines);
      return { draft: mapDraftWire(draft) };
    } catch (err) {
      if (err instanceof VariantUnavailableError) {
        throw jsonError(422, "variant_unavailable", err.message);
      }
      throw err;
    }
  });
}
