import { useEffect, useMemo, useRef, useState } from "react";
import { parseCountValue, formatCount, easeOutCubic } from "./countup";

// Animates a formatted stat string (e.g. "15", "$1,234", "0.8×") from 0 to its
// value on mount. SSR + first client render show the final value (hydration
// safe); the rAF tween starts after mount. Honors prefers-reduced-motion and
// falls back to the raw string for non-numeric values.
export function CountUp({
  value,
  durationMs = 900,
}: {
  value: string;
  durationMs?: number;
}) {
  const parsed = useMemo(() => parseCountValue(value), [value]);
  const [display, setDisplay] = useState(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!parsed || reduced) {
      setDisplay(value);
      return;
    }

    const start = performance.now();
    setDisplay(formatCount(0, parsed));
    const tick = (now: number) => {
      const t = Math.min((now - start) / durationMs, 1);
      setDisplay(formatCount(parsed.target * easeOutCubic(t), parsed));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [parsed, value, durationMs]);

  return <>{display}</>;
}
