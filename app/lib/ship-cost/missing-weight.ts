export interface WeightProbe {
  gramsSum: number | null;
}

/** Percent (0..100, rounded) of orders with no usable weight. 0 when no orders. */
export function missingWeightPct(orders: WeightProbe[]): number {
  if (orders.length === 0) return 0;
  const missing = orders.filter((o) => o.gramsSum == null || o.gramsSum <= 0).length;
  return Math.round((missing / orders.length) * 100);
}
