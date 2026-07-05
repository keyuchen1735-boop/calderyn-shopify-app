// app/components/CalderynHexMark.tsx
//
// Calderyn hexagon brand mark — shared, isomorphic SVG with no styling-system
// deps, so both the embedded Polaris guide and the dashboard cd-* guide render
// the same logo. Mirrors the sidebar mark in DashboardApp (teal fill, white
// stroke); on a colored hero, wrap it in a white chip.
export function CalderynHexMark({
  size = 28,
  fill = "#24556E",
  stroke = "#fff",
}: {
  size?: number;
  /** Hex body color; pass "currentColor" (or a CSS var) for tinted status marks. */
  fill?: string;
  /** Inner chevron color; pass a surface token so the knockout matches the card. */
  stroke?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="Calderyn"
    >
      <path
        d="M16 2 L28.12 9 L28.12 23 L16 30 L3.88 23 L3.88 9 Z"
        fill={fill}
      />
      <path
        d="M24.4 11.15 L16 6.3 L7.6 11.15 L7.6 20.85 L16 25.7 L24.4 20.85"
        stroke={stroke}
        strokeWidth="3.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
