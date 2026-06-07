// Pure helpers for the CountUp component. No JSX/DOM so they unit-test under the
// node test environment (see vitest.config.ts). The invariant the tests pin:
// formatCount(p.target, p) === the original display string, so the tween lands
// exactly on the value StatTile was given.

export type ParsedCount = {
  prefix: string;
  target: number;
  decimals: number;
  useGrouping: boolean;
  suffix: string;
};

// prefix = leading non-number chars ($), number = optional minus + digits/commas
// + optional decimals, suffix = trailing non-number chars (×, %).
const COUNT_RE = /^(\D*?)(-?[\d,]*\.?\d+)(\D*)$/;

export function parseCountValue(value: string): ParsedCount | null {
  const m = COUNT_RE.exec(value.trim());
  if (!m) return null;
  const [, prefix, rawNum, suffix] = m;
  const target = parseFloat(rawNum.replace(/,/g, ""));
  if (Number.isNaN(target)) return null;
  const dot = rawNum.indexOf(".");
  const decimals = dot === -1 ? 0 : rawNum.length - dot - 1;
  return { prefix, target, decimals, useGrouping: rawNum.includes(","), suffix };
}

export function formatCount(n: number, p: ParsedCount): string {
  const num = n.toLocaleString("en-US", {
    minimumFractionDigits: p.decimals,
    maximumFractionDigits: p.decimals,
    useGrouping: p.useGrouping,
  });
  return `${p.prefix}${num}${p.suffix}`;
}

// Ease-out cubic — matches the --cdn-ease-out feel used elsewhere in calderyn.css.
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
