// Merchant rule layer + selection strategy (#6.3). Each rule is applied EXPLICITLY
// and recorded by name in appliedRules; baseAmountCents always holds the pre-rule
// carrier amount, so every option is auditable and nothing is silently averaged
// (rule 7). Money is integer cents throughout.
import type { NormalizedRateOption } from "../ship-cost/adapters/rate-quote";
import type {
  DeliveryWindow,
  MerchantShipRules,
  SelectionStrategy,
  ShippingQuoteOption,
} from "./quote";

/**
 * Apply markup → handling → free-ship (in that order) to one carrier rate.
 * Free-ship is applied LAST because it zeroes the line; markup/handling are still
 * recorded so the provenance of "why this is free" stays explicit (rule 7).
 */
export function applyMerchantRules(
  opt: NormalizedRateOption,
  rules: MerchantShipRules | undefined,
  cartSubtotalCents: number,
  deliveryWindow: DeliveryWindow | null,
): ShippingQuoteOption {
  const baseAmountCents = opt.amountCents;
  const appliedRules: string[] = [];
  let amountCents = baseAmountCents;

  if (rules?.markupPct) {
    amountCents = Math.round(amountCents * (1 + rules.markupPct / 100));
    appliedRules.push(`markup:${rules.markupPct}%`);
  }
  if (rules?.handlingCents) {
    amountCents += rules.handlingCents;
    appliedRules.push(`handling:${rules.handlingCents}`);
  }
  if (rules?.freeShipThresholdCents != null && cartSubtotalCents >= rules.freeShipThresholdCents) {
    amountCents = 0;
    appliedRules.push("freeship");
  }

  // Never emit a negative charge: a misconfigured rule (e.g. markup < -100%) is
  // clamped to 0 rather than billed as a credit (rule 12 — fail safe, not silently).
  if (amountCents < 0) amountCents = 0;

  return {
    service: opt.serviceCode,
    serviceName: opt.serviceName,
    carrier: opt.carrier,
    amountCents,
    baseAmountCents,
    appliedRules,
    currency: opt.currency,
    deliveryWindow,
    guaranteed: opt.guaranteed,
    pickupAvailable: false, // carrier rate options carry no pickup signal in v1.
  };
}

/** Lowest merchant-facing amount; ties broken deterministically by service code. */
function cheapest(options: ShippingQuoteOption[]): ShippingQuoteOption {
  return options.reduce((best, o) =>
    o.amountCents < best.amountCents ||
    (o.amountCents === best.amountCents && o.service < best.service)
      ? o
      : best,
  );
}

/** Earliest arrival (by deliveryWindow.earliest); null windows sort last, then by amount. */
function fastest(options: ShippingQuoteOption[]): ShippingQuoteOption {
  const rank = (o: ShippingQuoteOption) =>
    o.deliveryWindow ? Date.parse(o.deliveryWindow.earliest) : Number.POSITIVE_INFINITY;
  return options.reduce((best, o) => {
    const ro = rank(o);
    const rb = rank(best);
    if (ro < rb) return o;
    if (ro === rb && o.amountCents < best.amountCents) return o;
    // Final tie-break by service code so equal arrival + equal price is still
    // deterministic regardless of carrier list order (mirrors `cheapest`).
    if (ro === rb && o.amountCents === best.amountCents && o.service < best.service) return o;
    return best;
  });
}

/**
 * Narrow the option set per the merchant's selection strategy.
 *   all      → every option (default)
 *   cheapest → the single lowest-priced option
 *   fastest  → the single earliest-arriving option
 *   blended  → ONE flattened blended-rate option presented to the buyer. The blend is
 *              explicit and recorded in appliedRules ("blended"), never a silent average
 *              (rule 7). v1 blend formula = cheapest-serviceable-as-flat; the blend
 *              formula is a future merchant-config knob.
 */
export function selectOptions(
  options: ShippingQuoteOption[],
  strategy: SelectionStrategy,
): ShippingQuoteOption[] {
  if (options.length === 0) return options;
  switch (strategy) {
    case "cheapest":
      return [cheapest(options)];
    case "fastest":
      return [fastest(options)];
    case "blended": {
      const flat = cheapest(options);
      return [{ ...flat, appliedRules: [...flat.appliedRules, "blended"] }];
    }
    case "all":
    default:
      return options;
  }
}
