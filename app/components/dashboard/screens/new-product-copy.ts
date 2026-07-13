// One-line summary shown instead of the per-variant grid until the merchant
// asks for it — the grid is the single heaviest element in the flow.
export function variantSummary(count: number, basePrice: string): string {
  const n = `${count} variant${count === 1 ? "" : "s"}`;
  const price = basePrice.trim();
  return price ? `${n} — all $${price} unless you change them` : `${n} — same price and stock`;
}
