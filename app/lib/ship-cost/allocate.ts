export interface AllocOrder {
  orderId: string;
  grams: number | null;
  itemCount: number;
  zoneMultiplier: number;
  fulfillmentCount: number;
}

export function allocatePeriodTotal(
  orders: AllocOrder[],
  totalCents: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (orders.length === 0) return out;

  const useWeight = orders.every((o) => o.grams != null && o.grams > 0);
  const weightOf = (o: AllocOrder) =>
    (useWeight ? (o.grams as number) : Math.max(o.itemCount, 1)) *
    o.zoneMultiplier *
    Math.max(o.fulfillmentCount, 1);

  const weights = orders.map(weightOf);
  const sum = weights.reduce((s, w) => s + w, 0) || orders.length;

  // Floor each, then hand out the leftover cents by largest fractional part.
  const raw = orders.map((_, i) => (totalCents * weights[i]) / sum);
  const floored = raw.map(Math.floor);
  let remainder = totalCents - floored.reduce((s, v) => s + v, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
    floored[order[k].i] += 1;
  }
  orders.forEach((o, i) => out.set(o.orderId, floored[i]));
  return out;
}
