// app/components/CalderynHexMark.tsx
//
// Calderyn hexagon-C brand mark — shared, isomorphic SVG with no styling-system
// deps, so every surface renders the same logo. Monochrome by design: the whole
// mark paints in one color (currentColor unless overridden) and the C channel
// is negative space, so the surface behind it shows through.
//
// Single even-odd path: outer hexagon, the ring hole, the core hexagon, and the
// right-side bridge that closes the C. Same geometry as the social-digest
// monogram (app/lib/social-digest/slides.server.ts), scaled to a 32 viewBox.
export const CALDERYN_MARK_PATH =
  "M16 4.182 L26.23 10.091 L26.23 21.909 L16 27.818 L5.77 21.909 L5.77 10.091 Z " +
  "M16 7.457 L23.398 11.728 L23.398 20.272 L16 24.543 L8.602 20.272 L8.602 11.728 Z " +
  "M16 9.739 L21.422 12.87 L21.422 19.13 L16 22.261 L10.578 19.13 L10.578 12.87 Z " +
  "M21.422 14.469 L23.398 14.469 L23.398 17.531 L21.422 17.531 Z";

export function CalderynHexMark({
  size = 28,
  color = "currentColor",
  className,
}: {
  size?: number;
  /** Mark color; defaults to currentColor so the surface's ink applies. */
  color?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="Calderyn"
      className={className}
    >
      <path d={CALDERYN_MARK_PATH} fill={color} fillRule="evenodd" />
    </svg>
  );
}
