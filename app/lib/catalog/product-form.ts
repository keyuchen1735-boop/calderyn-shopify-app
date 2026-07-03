// app/lib/catalog/product-form.ts
// Form-value converters shared by the product editor screens (edit form and the
// new-product flow) so create and edit parse merchant input identically. Pure —
// safe to import from the browser client.

/** Option rows are edited as raw text (not a parsed array) so typing the comma
 *  separator doesn't fight a controlled input; the array is derived on demand. */
export function parseOptionRows(
  rows: Array<{ name: string; values: string }>,
): Array<{ name: string; values: string[] }> {
  return rows
    .map((o) => ({
      name: o.name.trim(),
      values: o.values.split(",").map((s) => s.trim()).filter(Boolean),
    }))
    .filter((o) => o.name && o.values.length);
}

/** Price is stored in cents but edited in dollars. Empty/invalid → undefined. */
export function dollarsToCents(text: string): number | undefined {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined;
}

export function centsToDollars(cents?: number): string {
  return cents == null ? "" : String(cents / 100);
}

/** Positive integer from a text field; empty/zero/invalid → undefined. */
export function posInt(text: string): number | undefined {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  if (!Number.isFinite(n)) return undefined;
  const i = Math.trunc(n);
  return i > 0 ? i : undefined;
}

/** Non-negative integer from a text field; empty/invalid → undefined. */
export function nonNegInt(text: string): number | undefined {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : undefined;
}
