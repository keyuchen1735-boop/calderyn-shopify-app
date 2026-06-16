export interface SplitLine {
  lineId: string;
  grams: number | null;
  quantity: number;
}

export function splitOrderShipCost(
  orderShipCostCents: number,
  lines: SplitLine[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (lines.length === 0) return out;
  const useWeight = lines.every((l) => l.grams != null && l.grams > 0);
  const weightOf = (l: SplitLine) =>
    useWeight ? (l.grams as number) : Math.max(l.quantity, 1);
  const weights = lines.map(weightOf);
  const sum = weights.reduce((s, w) => s + w, 0) || lines.length;
  const raw = lines.map((_, i) => (orderShipCostCents * weights[i]) / sum);
  const floored = raw.map(Math.floor);
  let rem = orderShipCostCents - floored.reduce((s, v) => s + v, 0);
  const ord = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < ord.length && rem > 0; k++, rem--) floored[ord[k].i] += 1;
  lines.forEach((l, i) => out.set(l.lineId, floored[i]));
  return out;
}
