// EasyPost adapter (label-purchase direction). Reuses the cost adapter's HTTP Basic +
// base-URL + money parsing (easypost.server.ts). Unlike the rate-quote direction
// (easypost-rate.server.ts), which degrades to a static fallback because "no rate = no
// sale", THIS path moves the merchant's money — so every call here FAILS CLOSED with a
// typed error instead of degrading. Injectable fetch for contract tests.
//
// No new npm dependency (repo rule P6): built-in fetch + HTTP Basic + AbortController.

import { parseRateToCents, basicAuthHeader, apiBase } from "./easypost.server";
import { toEasyPostAddress, toEasyPostParcel } from "./easypost-rate.server";
import type { Address, Parcel } from "./rate-quote";

const LABEL_TIMEOUT_MS = 15_000; // label buys are merchant-initiated, not checkout-blocking.

/** Typed failure for every label-path error — the route maps `code` to a merchant message. */
export class LabelPurchaseError extends Error {
  readonly code:
    | "carrier_error" // EasyPost rejected the request / network / timeout
    | "shipment_mismatch" // shipment exists but references a different order (fail closed)
    | "not_purchased" // retrieve fallback found the shipment unbought
    | "no_rates"; // shipment created but no buyable rates came back
  constructor(code: LabelPurchaseError["code"], message: string) {
    super(message);
    this.name = "LabelPurchaseError";
    this.code = code;
  }
}

export interface LabelRateOption {
  id: string; // EasyPost rate id ("rate_...") — what buy() consumes
  carrier: string;
  service: string;
  amountCents: number;
  estDeliveryDays: number | null;
}

export interface CreatedLabelShipment {
  shipmentId: string;
  rates: LabelRateOption[];
}

export interface PurchasedLabel {
  shipmentId: string;
  labelUrl: string;
  /** null when EasyPost's selected_rate is missing/garbled — an unknown real cost must
   *  never be fabricated as $0 (the fulfillment row's column is nullable for this). */
  labelCostCents: number | null;
  trackingNumber: string | null;
  carrier: string | null;
  service: string | null;
  reference: string | null;
}

/** A shipment's current purchase state: its order reference and, when already bought, the label. */
export interface ShipmentState {
  reference: string | null;
  purchased: PurchasedLabel | null;
}

/** Fields we read off an EasyPost shipment in the label flow. */
interface EasyPostLabelShipment {
  id?: string | null;
  reference?: string | null;
  tracking_code?: string | null;
  rates?: Array<{
    id?: string | null;
    carrier?: string | null;
    service?: string | null;
    rate?: string | null;
    est_delivery_days?: number | null;
    delivery_days?: number | null;
  }> | null;
  selected_rate?: { rate?: string | null; carrier?: string | null; service?: string | null } | null;
  postage_label?: { label_url?: string | null } | null;
  error?: { message?: string | null } | null;
}

async function easyPostCall(
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body: Record<string, unknown> | null,
  fetchImpl: typeof fetch,
): Promise<{ status: number; json: EasyPostLabelShipment }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LABEL_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${apiBase()}${path}`, {
      method,
      headers: {
        Authorization: basicAuthHeader(apiKey),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as EasyPostLabelShipment;
    return { status: res.status, json };
  } catch (err) {
    throw new LabelPurchaseError(
      "carrier_error",
      `EasyPost request failed (${method} ${path}): ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function toRateOption(r: NonNullable<EasyPostLabelShipment["rates"]>[number]): LabelRateOption | null {
  const id = r.id?.trim();
  const carrier = r.carrier?.trim();
  const service = r.service?.trim();
  const amountCents = parseRateToCents(r.rate);
  if (!id || !carrier || !service || amountCents == null) return null;
  return {
    id,
    carrier,
    service,
    amountCents,
    estDeliveryDays: r.est_delivery_days ?? r.delivery_days ?? null,
  };
}

/**
 * Create the shipment a label will be bought against. `reference` binds the shipment to
 * OUR order id so the buy step can verify it is spending money on the right order.
 * `signature` maps to EasyPost's delivery_confirmation SIGNATURE option.
 */
export async function createLabelShipment(
  apiKey: string,
  input: { origin: Address; destination: Address; parcel: Parcel; signature: boolean; reference: string },
  fetchImpl: typeof fetch = fetch,
): Promise<CreatedLabelShipment> {
  const { status, json } = await easyPostCall(apiKey, "POST", "/shipments", {
    shipment: {
      reference: input.reference,
      to_address: toEasyPostAddress(input.destination),
      from_address: toEasyPostAddress(input.origin),
      parcel: toEasyPostParcel(input.parcel),
      ...(input.signature ? { options: { delivery_confirmation: "SIGNATURE" } } : {}),
    },
  }, fetchImpl);

  if (status < 200 || status >= 300 || !json.id) {
    throw new LabelPurchaseError(
      "carrier_error",
      `EasyPost shipment create failed (${status}): ${json.error?.message ?? "no shipment returned"}`,
    );
  }
  const rates = (json.rates ?? [])
    .map(toRateOption)
    .filter((r): r is LabelRateOption => r !== null)
    .sort((a, b) => a.amountCents - b.amountCents);
  if (!rates.length) {
    throw new LabelPurchaseError("no_rates", "EasyPost returned no buyable rates for this shipment");
  }
  return { shipmentId: String(json.id), rates };
}

function toPurchasedLabel(json: EasyPostLabelShipment): PurchasedLabel | null {
  const labelUrl = json.postage_label?.label_url?.trim();
  if (!json.id || !labelUrl) return null;
  return {
    shipmentId: String(json.id),
    labelUrl,
    labelCostCents: parseRateToCents(json.selected_rate?.rate),
    trackingNumber: json.tracking_code?.trim() || null,
    carrier: json.selected_rate?.carrier?.trim() || null,
    service: json.selected_rate?.service?.trim() || null,
    reference: json.reference ?? null,
  };
}

/**
 * GET the shipment's current state: its order reference (so the caller can verify
 * ownership BEFORE any money moves) and its purchased label when one already exists
 * (crash recovery — a retry must reuse it, never buy again). Structured state, not an
 * error-message parse: recovery never depends on EasyPost's error prose.
 */
export async function retrieveShipmentState(
  apiKey: string,
  shipmentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ShipmentState> {
  const { status, json } = await easyPostCall(apiKey, "GET", `/shipments/${encodeURIComponent(shipmentId)}`, null, fetchImpl);
  if (status < 200 || status >= 300) {
    throw new LabelPurchaseError(
      "carrier_error",
      `EasyPost shipment retrieve failed (${status}): ${json.error?.message ?? "unknown"}`,
    );
  }
  return { reference: json.reference ?? null, purchased: toPurchasedLabel(json) };
}

/** GET the shipment; succeeds only if it has already been purchased (has a label). */
export async function retrievePurchasedShipment(
  apiKey: string,
  shipmentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PurchasedLabel> {
  const state = await retrieveShipmentState(apiKey, shipmentId, fetchImpl);
  if (!state.purchased) {
    throw new LabelPurchaseError("not_purchased", `shipment ${shipmentId} has no purchased label`);
  }
  return state.purchased;
}

/**
 * Buy one rate of a shipment. The caller is expected to have verified the shipment's
 * reference via retrieveShipmentState BEFORE calling (no spend against the wrong
 * order); the post-buy check here is defense-in-depth. EasyPost allows exactly one
 * purchase per shipment, so on ANY buy failure this retrieves the shipment once: a
 * concurrent request (or an earlier crashed attempt) that already bought it yields
 * its label instead of an error — structurally, never by parsing error prose — and a
 * genuinely failed buy propagates the original carrier error.
 */
export async function buyShipmentRate(
  apiKey: string,
  shipmentId: string,
  rateId: string,
  expectedReference: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PurchasedLabel> {
  const { status, json } = await easyPostCall(
    apiKey,
    "POST",
    `/shipments/${encodeURIComponent(shipmentId)}/buy`,
    { rate: { id: rateId } },
    fetchImpl,
  );

  let label: PurchasedLabel | null = null;
  if (status >= 200 && status < 300) {
    label = toPurchasedLabel(json);
    if (!label) {
      throw new LabelPurchaseError("carrier_error", `EasyPost buy succeeded but returned no label for ${shipmentId}`);
    }
  } else {
    // Any failure: check once whether the shipment is in fact purchased (already-bought
    // retry, or a concurrent buy won the race) — if so its label is THE result. A
    // retrieve failure must not mask the original buy error.
    let state: ShipmentState | null = null;
    try {
      state = await retrieveShipmentState(apiKey, shipmentId, fetchImpl);
    } catch {
      state = null;
    }
    if (state?.purchased) {
      label = state.purchased;
    } else {
      throw new LabelPurchaseError(
        "carrier_error",
        `EasyPost buy failed (${status}): ${json.error?.message ?? "unknown"}`,
      );
    }
  }

  if (label.reference !== expectedReference) {
    throw new LabelPurchaseError(
      "shipment_mismatch",
      `shipment ${shipmentId} references ${label.reference ?? "nothing"}, expected ${expectedReference}`,
    );
  }
  return label;
}
