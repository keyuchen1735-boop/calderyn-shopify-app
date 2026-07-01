// Shipping dimensions: validation + metric->imperial conversion for owned variants.
// Weight is stored in grams and dimensions in millimetres on variant_dim (metric
// integers); the shipping quote engine consumes inches + ounces, so toParcelDims
// converts at the read boundary. Validation is format-strict (a provided value must be
// a positive integer within a sane ceiling) but presence-soft (a shippable variant may
// still save with fields missing and quote at low confidence).

export interface VariantShippingFields {
  grams?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  requiresShipping?: boolean | null;
}

const MAX_MM = 3000; // 3 m per axis
const MAX_GRAMS = 2_000_000; // 2 t
const MM_PER_IN = 25.4;
const G_PER_OZ = 28.349523125;

const FIELD_MAX: Record<"grams" | "lengthMm" | "widthMm" | "heightMm", number> = {
  grams: MAX_GRAMS,
  lengthMm: MAX_MM,
  widthMm: MAX_MM,
  heightMm: MAX_MM,
};

export type DimValidation = { ok: true } | { ok: false; error: string };

// Format-strict: each PROVIDED field must be an integer > 0 and <= its ceiling.
// null/undefined = "not provided" and is allowed (presence-soft).
export function validateVariantDims(v: VariantShippingFields): DimValidation {
  for (const key of ["grams", "lengthMm", "widthMm", "heightMm"] as const) {
    const val = v[key];
    if (val == null) continue;
    if (typeof val !== "number" || !Number.isInteger(val) || val <= 0) {
      return { ok: false, error: `${key} must be a positive integer` };
    }
    if (val > FIELD_MAX[key]) {
      return { ok: false, error: `${key} exceeds the maximum of ${FIELD_MAX[key]}` };
    }
  }
  return { ok: true };
}

// A shippable variant is "shipping-complete" only when weight AND all three dims are
// set. A non-shipping variant (requiresShipping === false) is complete by definition.
export function isShippingComplete(v: VariantShippingFields): boolean {
  if (v.requiresShipping === false) return true;
  return v.grams != null && v.lengthMm != null && v.widthMm != null && v.heightMm != null;
}

export interface ParcelDims {
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  weightOz: number | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// Convert stored metric fields to the shipping engine's inches/ounces. A missing metric
// field passes through as null (the engine treats null as "unknown" and falls back to an
// estimated parcel).
export function toParcelDims(v: VariantShippingFields): ParcelDims {
  return {
    lengthIn: v.lengthMm == null ? null : round2(v.lengthMm / MM_PER_IN),
    widthIn: v.widthMm == null ? null : round2(v.widthMm / MM_PER_IN),
    heightIn: v.heightMm == null ? null : round2(v.heightMm / MM_PER_IN),
    weightOz: v.grams == null ? null : round2(v.grams / G_PER_OZ),
  };
}
