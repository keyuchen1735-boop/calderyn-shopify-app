// app/lib/order/label.server.ts
//
// EasyPost label purchase for the fulfill flow (shipping deferred D2). Two halves:
//   quoteLabelRates  — create an EasyPost shipment for the order's OPEN units and return
//                      its buyable rates (no money moves).
//   buyLabelAndFulfill — buy the merchant-selected rate (MONEY: the merchant's EasyPost
//                      balance), then run the existing fulfillment executor with the
//                      label's tracking auto-filled, and persist the label on the
//                      fulfillment row.
//
// MONEY POSTURE (fail-closed + idempotent):
// - Every precondition (credential, order state, address, parcel weight) is checked
//   BEFORE the buy call; any ambiguity throws instead of buying.
// - EasyPost allows exactly one purchase per shipment, so the shipment id is the
//   idempotency key: a fulfillment row already carrying it short-circuits (replay), and
//   a retry that hits "already purchased" recovers the existing label (adapter) — a
//   double-spend is impossible by construction.
// - The shipment's `reference` is verified against `order:<orderId>` BEFORE the buy (a
//   posted shipment id can never spend against the wrong order).
//
// KNOWN WINDOW (same read-then-act ponytail fulfill.server documents): two requests that
// pass the precondition read CONCURRENTLY can still both buy — e.g. two tabs that each
// quoted their own shipment for the same units. Sequential attempts are refused by the
// pre-buy remaining check; closing the concurrent window needs the same security-definer
// RPC + row lock the fulfillment executor defers to.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "~/lib/supabase.server";
import { loadEasyPostApiKey } from "~/lib/ship-cost/adapters/easypost.server";
import { CalderynError } from "../calderyn.server";
import { getShopOrigin } from "~/lib/commerce/origin.server";
import { PICKUP_SERVICE_NAME } from "~/lib/commerce/types";
import { toParcel } from "~/lib/shipping/parcel.server";
import {
  buyShipmentRate,
  createLabelShipment,
  retrieveShipmentState,
  LabelPurchaseError,
  type CreatedLabelShipment,
  type PurchasedLabel,
} from "~/lib/ship-cost/adapters/easypost-label.server";
import type { Address, Parcel } from "~/lib/ship-cost/adapters/rate-quote";
import {
  executeFulfillAction,
  loadRemainingByLine,
  type FulfillActionResult,
  type FulfillLineInput,
} from "./fulfill.server";
import { FULFILLABLE_ORDER_STATES, isOrderState, type OrderState } from "./state";
import { loadDefaultShippingAddress } from "./detail.server";

/** Adapter seam for contract tests: inject fakes for the EasyPost calls. */
export interface LabelAdapter {
  create: typeof createLabelShipment;
  buy: typeof buyShipmentRate;
  retrieve: typeof retrieveShipmentState;
}
const REAL_ADAPTER: LabelAdapter = {
  create: createLabelShipment,
  buy: buyShipmentRate,
  retrieve: retrieveShipmentState,
};

async function loadApiKey(shopId: string, sb: SupabaseClient): Promise<string> {
  const apiKey = await loadEasyPostApiKey(shopId, sb);
  if (!apiKey) {
    throw new CalderynError({
      code: "no_label_carrier",
      status: 422,
      message: "Connect EasyPost in Settings before buying shipping labels.",
    });
  }
  return apiKey;
}

interface LabelOrderContext {
  destination: Address;
  parcel: Parcel;
  signature: boolean;
  reference: string;
}

/**
 * Everything a shipment create needs, with every failure mode a typed 4xx BEFORE any
 * carrier call: order exists + fulfillable, not a pickup order, buyer address on file,
 * the shipping units are validated against what is actually open, and every shipping
 * item has a weight (an unweighted item would silently underrate the parcel).
 *
 * `lines` = the units the merchant is shipping (validated against remaining, so an
 * over-fulfil fails HERE, before any money). Omitted = everything unfulfilled.
 */
async function loadLabelOrderContext(
  shopId: string,
  orderId: string,
  sb: SupabaseClient,
  lines?: FulfillLineInput[],
): Promise<LabelOrderContext> {
  const orderRes = await sb
    .from("orders")
    .select("id, state, buyer_id, shipping_service")
    .eq("shop_id", shopId)
    .eq("id", orderId)
    .maybeSingle();
  if (orderRes.error) throw orderRes.error;
  if (!orderRes.data) {
    throw new CalderynError({ code: "order_not_found", status: 404, message: `Order ${orderId} not found.` });
  }
  const order = orderRes.data as Record<string, unknown>;
  const stateRaw = String(order.state);
  if (!isOrderState(stateRaw) || !FULFILLABLE_ORDER_STATES.has(stateRaw)) {
    throw new CalderynError({
      code: "order_not_fulfillable",
      status: 409,
      message: `Order ${orderId} is '${stateRaw}'; labels can only be bought for paid or partially fulfilled orders.`,
    });
  }
  if (String(order.shipping_service ?? "") === PICKUP_SERVICE_NAME) {
    throw new CalderynError({
      code: "pickup_order",
      status: 422,
      message: "This is a store-pickup order; nothing ships, so there is no label to buy.",
    });
  }

  const buyerId = order.buyer_id == null ? null : String(order.buyer_id);
  const addr = buyerId ? await loadDefaultShippingAddress(sb, shopId, buyerId) : null;
  if (!addr || !addr.line1) {
    throw new CalderynError({
      code: "no_shipping_address",
      status: 422,
      message: "This order has no shipping address on file to buy a label for.",
    });
  }

  // The units this label covers: the merchant's selection validated against remaining
  // (fail closed BEFORE money — executeFulfillAction re-validates after), or every open
  // unit when no selection was given. A partially fulfilled order's label must never be
  // weighted for units that already shipped.
  const { orderLines, remaining } = await loadRemainingByLine(sb, shopId, orderId);
  const lineById = new Map(orderLines.map((l) => [l.id, l]));
  let shipping: Array<{ line: (typeof orderLines)[number]; units: number }>;
  if (lines !== undefined) {
    shipping = [];
    for (const req of lines) {
      const line = lineById.get(req.orderLineId);
      if (!line) {
        throw new CalderynError({
          code: "line_not_on_order",
          status: 409,
          message: `Order line ${req.orderLineId} is not on order ${orderId}.`,
        });
      }
      const open = remaining.get(req.orderLineId) ?? 0;
      if (req.quantity > open) {
        throw new CalderynError({
          code: "over_fulfil",
          status: 422,
          message: `Order line ${req.orderLineId} has ${open} remaining; cannot fulfill ${req.quantity}.`,
        });
      }
      shipping.push({ line, units: req.quantity });
    }
  } else {
    shipping = orderLines
      .map((l) => ({ line: l, units: remaining.get(l.id) ?? 0 }))
      .filter((s) => s.units > 0);
  }
  if (!shipping.length) {
    throw new CalderynError({
      code: "nothing_to_fulfil",
      status: 422,
      message: `Order ${orderId} has nothing left to fulfill.`,
    });
  }

  const variantIds = [...new Set(shipping.map((s) => s.line.variantId))];
  const shipRes = await sb
    .from("variant_shipping")
    .select("variant_id, weight_grams, length_mm, width_mm, height_mm, signature_required")
    .eq("shop_id", shopId)
    .in("variant_id", variantIds);
  if (shipRes.error) throw shipRes.error;
  const shipByVariant = new Map(
    ((shipRes.data ?? []) as Record<string, unknown>[]).map((r) => [String(r.variant_id), r]),
  );

  // v1 single parcel: total weight of the shipping units, largest single-item dims
  // (conservative enough for one box; multi-parcel packing stays with the quote
  // engine's roadmap). EVERY item must carry a weight — one unweighted item would
  // silently buy an underweight label the carrier bills an adjustment for.
  let weightOz = 0;
  let lengthIn = 0;
  let widthIn = 0;
  let heightIn = 0;
  let signature = false;
  const unweighted: string[] = [];
  for (const s of shipping) {
    const ship = shipByVariant.get(s.line.variantId);
    const parcel = ship ? toParcel(ship) : null;
    if (!parcel || parcel.weightOz <= 0) {
      unweighted.push(s.line.title || s.line.variantId);
      continue;
    }
    weightOz += parcel.weightOz * s.units;
    lengthIn = Math.max(lengthIn, parcel.lengthIn);
    widthIn = Math.max(widthIn, parcel.widthIn);
    heightIn = Math.max(heightIn, parcel.heightIn);
    if (ship?.signature_required === true) signature = true;
  }
  if (unweighted.length) {
    throw new CalderynError({
      code: "no_parcel_weight",
      status: 422,
      message: `${unweighted.join(", ")} ${unweighted.length === 1 ? "has" : "have"} no shipping weight set, so a label can't be rated. Add weights in Products.`,
    });
  }

  return {
    destination: {
      name: addr.name ?? undefined,
      street1: addr.line1,
      street2: addr.line2 ?? undefined,
      city: addr.city ?? "",
      state: addr.region ?? "",
      zip: addr.postal ?? "",
      country: addr.country || "US",
    },
    parcel: { lengthIn, widthIn, heightIn, weightOz },
    signature,
    reference: `order:${orderId}`,
  };
}

/** Create the EasyPost shipment for the units being shipped and return its buyable rates. */
export async function quoteLabelRates(
  shopId: string,
  orderId: string,
  lines?: FulfillLineInput[],
  adapter: LabelAdapter = REAL_ADAPTER,
  sb: SupabaseClient = getSupabase(),
): Promise<CreatedLabelShipment> {
  if (!shopId) throw new Error("shopId is required");
  if (!orderId) throw new CalderynError({ code: "order_not_found", status: 404, message: "orderId is required." });
  const [apiKey, ctx, origin] = await Promise.all([
    loadApiKey(shopId, sb),
    loadLabelOrderContext(shopId, orderId, sb, lines),
    getShopOrigin(shopId),
  ]);
  return adapter.create(apiKey, {
    origin,
    destination: ctx.destination,
    parcel: ctx.parcel,
    signature: ctx.signature,
    reference: ctx.reference,
  });
}

export interface BuyLabelInput {
  orderId: string;
  shipmentId: string;
  rateId: string;
  /** Omitted = fulfill everything unfulfilled (mirrors executeFulfillAction). */
  lines?: FulfillLineInput[];
  notify: boolean;
  idempotencyKey: string;
  actor?: string;
}

export interface BuyLabelResult extends FulfillActionResult {
  labelUrl: string | null;
  labelCostCents: number | null;
  trackingNumber: string | null;
  carrier: string | null;
}

/**
 * Buy the selected rate, then fulfill with the label's tracking. See the module header
 * for the money posture. A failure AFTER the buy but before the fulfillment persists is
 * recovered by retrying with the SAME shipment id: the adapter's already-purchased
 * fallback returns the existing label without spending again.
 */
export async function buyLabelAndFulfill(
  shopId: string,
  input: BuyLabelInput,
  adapter: LabelAdapter = REAL_ADAPTER,
  sb: SupabaseClient = getSupabase(),
): Promise<BuyLabelResult> {
  if (!shopId) throw new Error("shopId is required");
  if (!input.orderId || !input.shipmentId || !input.rateId) {
    throw new CalderynError({
      code: "invalid_label_buy",
      status: 422,
      message: "orderId, shipmentId and rateId are required.",
    });
  }
  if (!input.idempotencyKey) {
    throw new CalderynError({ code: "invalid_label_buy", status: 422, message: "idempotencyKey is required." });
  }

  // Replay short-circuit: a fulfillment in this shop already carries this shipment —
  // the label was bought AND persisted; return it without touching EasyPost again.
  const existing = await sb
    .from("fulfillment")
    .select("id, order_id, label_url, label_cost_cents, tracking_number, carrier")
    .eq("shop_id", shopId)
    .eq("easypost_shipment_id", input.shipmentId)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) {
    const row = existing.data as Record<string, unknown>;
    if (String(row.order_id) !== input.orderId) {
      throw new CalderynError({
        code: "shipment_mismatch",
        status: 409,
        message: "This shipment was already used for a different order.",
      });
    }
    const orderRes = await sb.from("orders").select("state").eq("shop_id", shopId).eq("id", input.orderId).maybeSingle();
    if (orderRes.error) throw orderRes.error;
    const stateRaw = orderRes.data ? String((orderRes.data as Record<string, unknown>).state) : "paid";
    return {
      auditId: "",
      fulfillmentId: String(row.id),
      orderState: (isOrderState(stateRaw) ? stateRaw : "paid") as OrderState,
      fulfilledUnits: 0,
      notified: false,
      replayed: true,
      labelUrl: row.label_url == null ? null : String(row.label_url),
      labelCostCents: row.label_cost_cents == null ? null : Number(row.label_cost_cents),
      trackingNumber: row.tracking_number == null ? null : String(row.tracking_number),
      carrier: row.carrier == null ? null : String(row.carrier),
    };
  }

  // Ownership BEFORE anything else, and BEFORE any spend: the shipment on the wire must
  // reference THIS order, and if an earlier crashed attempt already bought it we recover
  // that label here — deliberately ahead of the fulfillability preconditions, which a
  // paid-for label must never be gated behind (money already moved).
  const apiKey = await loadApiKey(shopId, sb);
  const reference = `order:${input.orderId}`;
  let shipmentState;
  try {
    shipmentState = await adapter.retrieve(apiKey, input.shipmentId);
  } catch (err) {
    if (err instanceof LabelPurchaseError) {
      throw new CalderynError({
        code: `label_${err.code}`,
        status: 502,
        message: `The shipment couldn't be checked before buying: ${err.message}`,
      });
    }
    throw err;
  }
  if (shipmentState.reference !== reference) {
    throw new CalderynError({
      code: "shipment_mismatch",
      status: 409,
      message: "This shipment doesn't belong to this order; refresh and get fresh rates.",
    });
  }

  let label: PurchasedLabel;
  if (shipmentState.purchased) {
    // Crash recovery: bought on a previous attempt, never persisted. Reuse it.
    label = shipmentState.purchased;
  } else {
    // Fresh buy: full precondition check first — including the requested lines against
    // what is actually open — so every refusal happens while no money has moved.
    await loadLabelOrderContext(shopId, input.orderId, sb, input.lines);
    try {
      label = await adapter.buy(apiKey, input.shipmentId, input.rateId, reference);
    } catch (err) {
      if (err instanceof LabelPurchaseError) {
        throw new CalderynError({
          code: `label_${err.code}`,
          status: err.code === "shipment_mismatch" ? 409 : 502,
          message:
            err.code === "shipment_mismatch"
              ? "This shipment doesn't belong to this order; refresh and get fresh rates."
              : `The label couldn't be bought: ${err.message}`,
        });
      }
      throw err;
    }
  }

  // Money has moved. A fulfillment failure from here must SURFACE the purchased label to
  // the merchant (tracking + URL in the error they see), never bury it in server logs.
  let result: FulfillActionResult;
  try {
    result = await executeFulfillAction(
      shopId,
      {
        orderId: input.orderId,
        lines: input.lines,
        trackingNumber: label.trackingNumber,
        carrier: label.carrier,
        notify: input.notify,
        idempotencyKey: input.idempotencyKey,
        actor: input.actor ?? "merchant",
      },
      sb,
    );
  } catch (err) {
    console.error(
      `[label] label bought for order ${input.orderId} (shop ${shopId}) — shipment ${label.shipmentId}, ` +
        `tracking ${label.trackingNumber ?? "n/a"}, ${label.labelUrl} — but fulfillment failed:`,
      err,
    );
    const cause = err instanceof CalderynError ? ` (${err.message})` : "";
    throw new CalderynError({
      code: "label_bought_fulfill_failed",
      status: 409,
      message:
        `The label was bought (tracking ${label.trackingNumber ?? "n/a"}) but the order couldn't be marked fulfilled${cause}. ` +
        `Open the label at ${label.labelUrl} and record the fulfillment manually.`,
    });
  }

  if (result.fulfillmentId) {
    const upd = await sb
      .from("fulfillment")
      .update({
        label_url: label.labelUrl,
        label_cost_cents: label.labelCostCents,
        easypost_shipment_id: label.shipmentId,
      })
      .eq("shop_id", shopId)
      .eq("id", result.fulfillmentId);
    if (upd.error) {
      // The fulfillment + label both exist; only the linkage write failed. Loud, not fatal.
      console.error(
        `[label] failed to persist label on fulfillment ${result.fulfillmentId} (order ${input.orderId}, shop ${shopId}):`,
        upd.error,
      );
    }
  }

  return {
    ...result,
    labelUrl: label.labelUrl,
    labelCostCents: label.labelCostCents,
    trackingNumber: label.trackingNumber,
    carrier: label.carrier,
  };
}
