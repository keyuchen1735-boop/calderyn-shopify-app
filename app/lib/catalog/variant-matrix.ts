// app/lib/catalog/variant-matrix.ts
// Pure helper: turn the editor's option definitions into the variant grid. The
// grid is the cartesian product of the (usable) option values; any prior variant
// whose exact option combination still exists keeps its SKU/price/stock, while
// new combinations start blank. With no usable options, the product has one
// default variant (preserving the existing one if present).
import type { VariantDraft } from "~/lib/dashboard/client";

function cartesian(values: string[][]): string[][] {
  return values.reduce<string[][]>(
    (acc, list) => acc.flatMap((combo) => list.map((v) => [...combo, v])),
    [[]],
  );
}

// Key a combination unambiguously. join() with any single separator collides when
// option values contain that separator (["A","B C"] vs ["A B","C"]); JSON.stringify
// of the ordered array does not.
function comboKey(values: string[]): string {
  return JSON.stringify(values);
}

function hasId(v: VariantDraft): boolean {
  return typeof v.id === "string" && v.id.length > 0;
}

export function buildVariantMatrix(
  options: Array<{ name: string; values: string[] }>,
  existing: VariantDraft[],
): VariantDraft[] {
  const usable = options.filter((o) => o.name.trim() && o.values.length);
  if (!usable.length) {
    // No options: collapse to a default. NEVER silently drop an id-bearing
    // (order-linked) variant - keep them all as optionless rows so the save path
    // doesn't delete+reinsert their variant_dim rows. Only synthesize a lone
    // default when there is no id-bearing variant to preserve.
    const idful = existing.filter(hasId);
    if (idful.length) return idful.map((v) => ({ ...v, optionValues: [] }));
    return [{ ...(existing[0] ?? {}), optionValues: [] }];
  }

  // Carry a prior variant (with its id + data) forward ONLY to the combination
  // with the exact same option-value labels - an unchanged combination keeps its
  // id. An unmatched combination is a brand-new, id-less variant.
  //
  // We deliberately do NOT reuse a "leftover" id-bearing variant for a renamed or
  // reordered combination. A label-keyed matrix cannot tell a single-value RENAME
  // (M -> Medium) from a REMOVE+ADD (M removed, L added) - both present as exactly
  // one unmatched combo plus one leftover variant - and reusing an order-linked id
  // for a different combination would silently reassign that variant's order
  // history (sku_dim.id == variant_dim.id, with order_line_fact/refund_fact FK'd to
  // sku_dim ON DELETE SET NULL and the derived sku_* tables ON DELETE CASCADE).
  // So restructuring an option value on a product that already has order history is
  // lossy here by design (the renamed value becomes a fresh variant); a fully
  // non-lossy restructure needs per-option-value identity in the editor AND the
  // write path (reconcile option values by id instead of wipe+rewrite) - a deferred
  // Slice-1 follow-up.
  const byKey = new Map<string, VariantDraft>();
  for (const v of existing) byKey.set(comboKey(v.optionValues ?? []), v);
  return cartesian(usable.map((o) => o.values)).map((combo) => {
    const prior = byKey.get(comboKey(combo));
    return { ...(prior ?? {}), optionValues: combo };
  });
}
