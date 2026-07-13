import type { VariantBalanceVM, VariantDraft } from "~/lib/dashboard/client";
import { money } from "../format";

export interface EditorSectionSummary {
  text: string;
  warning: boolean;
}

function stockText(onHand: number, locations?: number): EditorSectionSummary {
  if (onHand <= 0) return { text: "Out of stock ⚠", warning: true };
  if (locations === undefined) return { text: `${onHand} on hand`, warning: false };
  return {
    text: `${onHand} on hand · ${locations} location${locations === 1 ? "" : "s"}`,
    warning: false,
  };
}

export function variantsSummary(
  options: ReadonlyArray<{ name: string; values: readonly string[] }>,
  variants: readonly VariantDraft[],
): EditorSectionSummary {
  const price = variants[0]?.retailPriceCents;
  if (variants.length === 1 && Number.isFinite(price)) {
    return { text: `Single variant — ${money(price as number)}`, warning: false };
  }
  if (variants.length === 1) return { text: "Single variant — no price", warning: false };

  const option = options.length === 1 && options[0].values.length === variants.length
    ? options[0].name.trim().toLowerCase()
    : "";
  const descriptor = option === "size" || option === "color"
    ? `${variants.length} ${option}s`
    : `${variants.length} variants`;
  const prices = variants
    .map((variant) => variant.retailPriceCents)
    .filter((value): value is number => Number.isFinite(value));
  if (prices.length === 0) return { text: `${descriptor} — no prices`, warning: false };
  if (prices.length !== variants.length || prices.some((value) => value !== prices[0])) {
    return { text: `${descriptor} — mixed prices`, warning: false };
  }
  return { text: `${descriptor} — all ${money(prices[0])}`, warning: false };
}

export function stockSummary(
  variants: readonly VariantDraft[],
  balancesByVariant: Readonly<Record<string, readonly VariantBalanceVM[]>>,
): EditorSectionSummary {
  const tracked = variants.filter((variant) => variant.inventoryTracked !== false);
  if (tracked.length === 0) return { text: "Not tracked", warning: false };

  const reported = tracked.every(
    (variant) => variant.id && Object.prototype.hasOwnProperty.call(balancesByVariant, variant.id),
  );
  if (reported) {
    const rows = tracked.flatMap((variant) => balancesByVariant[variant.id as string]);
    const onHand = rows.reduce((sum, row) => sum + row.onHand, 0);
    const locations = new Set(rows.map((row) => row.locationId)).size;
    return stockText(onHand, locations);
  }

  const onHand = tracked.reduce((sum, variant) => sum + (variant.inventoryOnHand ?? 0), 0);
  return stockText(onHand);
}

function centimetres(mm: number): string {
  return (mm / 10).toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function positive(value: number | undefined): value is number {
  return Number.isFinite(value) && (value as number) > 0;
}

export function shippingSummary(variants: readonly VariantDraft[]): EditorSectionSummary {
  const physical = variants.filter((variant) => variant.requiresShipping !== false);
  if (physical.length === 0) return { text: "No shipping needed", warning: false };
  const missingWeight = physical.some((variant) => !positive(variant.weightGrams));
  const missingDimensions = physical.some(
    (variant) =>
      !positive(variant.lengthMm) || !positive(variant.widthMm) || !positive(variant.heightMm),
  );
  if (missingWeight || missingDimensions) {
    const missing = missingWeight && missingDimensions
      ? "weight + dimensions"
      : missingWeight
        ? "weight"
        : "dimensions";
    return { text: `Missing ${missing} ⚠`, warning: true };
  }

  const shape = physical[0];
  const sameShape = physical.every(
    (variant) =>
      variant.weightGrams === shape.weightGrams &&
      variant.lengthMm === shape.lengthMm &&
      variant.widthMm === shape.widthMm &&
      variant.heightMm === shape.heightMm,
  );
  if (!sameShape) {
    return {
      text: `${physical.length} variants · shipping complete`,
      warning: false,
    };
  }
  return {
    text: `${shape.weightGrams} g · ${centimetres(shape.lengthMm as number)}×${centimetres(shape.widthMm as number)}×${centimetres(shape.heightMm as number)} cm`,
    warning: false,
  };
}

export function searchSummary(input: {
  handle: string;
  savedHandle: string;
  metaTitle: string;
  metaDescription: string;
  seoAvailable: boolean;
}): EditorSectionSummary {
  if (!input.seoAvailable) return { text: "Temporarily unavailable", warning: false };
  const custom: string[] = [];
  if (input.handle.trim() !== input.savedHandle.trim()) custom.push("address");
  if (input.metaTitle.trim()) custom.push("title");
  if (input.metaDescription.trim()) custom.push("description");
  return {
    text: custom.length ? `Custom ${custom.join(" + ")}` : "Automatic",
    warning: false,
  };
}

export function organizeSummary(
  vendor: string,
  tagsText: string,
  collectionIds: readonly string[],
): EditorSectionSummary {
  const name = vendor.trim();
  const tagCount = tagsText.split(",").filter((tag) => tag.trim()).length;
  if (!name && tagCount === 0 && collectionIds.length === 0) {
    return { text: "Nothing yet", warning: false };
  }
  const parts: string[] = [];
  if (name) parts.push(name);
  if (tagCount > 0) parts.push(`${tagCount} tag${tagCount === 1 ? "" : "s"}`);
  parts.push(
    collectionIds.length > 0
      ? `${collectionIds.length} collection${collectionIds.length === 1 ? "" : "s"}`
      : "no collections",
  );
  return { text: parts.join(" · "), warning: false };
}
