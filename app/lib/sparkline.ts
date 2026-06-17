// Pure SVG-path geometry for a minimal trend sparkline. Kept separate from any
// component so it's unit-testable and the extension (Polaris, hand-rolled inline
// SVG) can share one definition. The dashboard has its own Sparkline primitive in
// the dashboard kit; this mirrors its math (2px inner padding L/R, 3px T/B) so the
// two surfaces draw the same shape.

/**
 * Build the `d` attribute for a polyline through `values`, fitted to a
 * `width`×`height` box. Returns "" for fewer than two points (nothing to draw —
 * callers should render an empty state instead). A zero range (all equal values)
 * is clamped to 1 so a flat series renders a straight line along the bottom of
 * the box (matching the dashboard Sparkline primitive), never NaN.
 */
export function sparklinePath(values: number[], width: number, height: number): string {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * (width - 4) + 2;
      const y = height - 3 - ((v - min) / range) * (height - 6);
      return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}
