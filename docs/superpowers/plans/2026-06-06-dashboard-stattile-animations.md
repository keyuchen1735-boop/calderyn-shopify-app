# Dashboard StatTile Animations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three subtle, reduced-motion-aware animations to the dashboard — hover-lift on clickable tiles, count-up on numeric stats, and a fade-in stagger on the dashboard stat row.

**Architecture:** Hover-lift and stagger are pure CSS in `app/components/calderyn/calderyn.css`. Count-up is a thin React component (`CountUp`) backed by a pure, unit-tested logic module (`countup.ts`) because the test env is node-only (no DOM). The stagger uses `animation-fill-mode: backwards` so the entrance `transform` reverts to base after running, leaving hover-lift's `transform` free (avoids a same-property collision).

**Tech Stack:** Remix + React 18, Shopify Polaris, plain CSS (scoped `.cdn-` prefix), Vitest (node env).

**Spec:** `docs/superpowers/specs/2026-06-06-dashboard-stattile-animations-design.md`

---

## File structure

- `app/components/calderyn/countup.ts` — **new.** Pure helpers: `parseCountValue`, `formatCount`, `easeOutCubic`. No JSX/DOM (unit-testable in node env).
- `app/components/calderyn/countup.test.ts` — **new.** Vitest unit tests for the pure helpers.
- `app/components/calderyn/CountUp.tsx` — **new.** Thin React component: rAF tween, reduced-motion + SSR safe.
- `app/components/calderyn/index.tsx` — **modify.** Import + re-export `CountUp`; render it inside `StatTile`.
- `app/components/calderyn/calderyn.css` — **modify.** Hover-lift rule, stagger keyframe + row rules, reduced-motion extensions.
- `app/routes/app._index.tsx` — **modify.** Wrap the stat-row `InlineGrid` in `<div className="cdn-stat-row">`.

---

## Task 1: CountUp pure logic (TDD)

**Files:**
- Create: `app/components/calderyn/countup.ts`
- Test: `app/components/calderyn/countup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/components/calderyn/countup.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseCountValue, formatCount, easeOutCubic } from "./countup";

describe("parseCountValue + formatCount", () => {
  const cases = ["15", "$0", "0.8×", "$1,234", "1.50", "-5%"];
  it.each(cases)("round-trips %s exactly at the target", (value) => {
    const p = parseCountValue(value);
    expect(p).not.toBeNull();
    expect(formatCount(p!.target, p!)).toBe(value);
  });

  it("formats a mid-tween value below the target", () => {
    const p = parseCountValue("$1,234")!;
    expect(formatCount(0, p)).toBe("$0");
  });

  it("preserves decimal places while tweening", () => {
    const p = parseCountValue("0.8×")!;
    expect(formatCount(0, p)).toBe("0.0×");
  });

  it("returns null for non-numeric values", () => {
    expect(parseCountValue("—")).toBeNull();
    expect(parseCountValue("N/A")).toBeNull();
  });
});

describe("easeOutCubic", () => {
  it("is pinned at the endpoints and eases out", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/components/calderyn/countup.test.ts`
Expected: FAIL — cannot resolve `./countup` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `app/components/calderyn/countup.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/components/calderyn/countup.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Commit**

```bash
git add app/components/calderyn/countup.ts app/components/calderyn/countup.test.ts
git commit -m "components/calderyn: count-up parse/format helpers + tests"
```

---

## Task 2: CountUp component + StatTile integration

**Files:**
- Create: `app/components/calderyn/CountUp.tsx`
- Modify: `app/components/calderyn/index.tsx` (import/re-export + StatTile value render)

No unit test: the node test env has no DOM, so the component (rAF/`matchMedia`)
is verified by typecheck + build + manual check at the end (Task 5).

- [ ] **Step 1: Create the component**

Create `app/components/calderyn/CountUp.tsx`:

```tsx
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
```

- [ ] **Step 2: Wire CountUp into StatTile**

In `app/components/calderyn/index.tsx`, add the import near the top with the other
local imports:

```tsx
import { CountUp } from "./CountUp";
```

Re-export it alongside the other component exports (so callers can import from the
index). Add this line near the other `export` declarations:

```tsx
export { CountUp } from "./CountUp";
```

Then, inside `StatTile`, replace the raw value render. Find:

```tsx
                <Text as="p" variant="heading2xl" tone={tone}>
                  <span className="cdn-tnum">{value}</span>
                </Text>
```

Replace with:

```tsx
                <Text as="p" variant="heading2xl" tone={tone}>
                  <span className="cdn-tnum">
                    <CountUp value={value} />
                  </span>
                </Text>
```

(`value` is guaranteed defined here — this branch is inside `value !== undefined`.)

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add app/components/calderyn/CountUp.tsx app/components/calderyn/index.tsx
git commit -m "components/calderyn: animate StatTile values with CountUp"
```

---

## Task 3: Hover-lift CSS

**Files:**
- Modify: `app/components/calderyn/calderyn.css` (the `.cdn-tile-button` block + reduced-motion block)

- [ ] **Step 1: Add the transition + hover rule**

In `app/components/calderyn/calderyn.css`, find the current `.cdn-tile-button` rule:

```css
.cdn-tile-button {
  all: unset;
  display: block;
  width: 100%;
  height: 100%;
  cursor: pointer;
  border-radius: 12px;
}
```

Replace it with (adds `transition` + a new `:hover` rule):

```css
.cdn-tile-button {
  all: unset;
  display: block;
  width: 100%;
  height: 100%;
  cursor: pointer;
  border-radius: 12px;
  transition: transform 200ms var(--cdn-ease-out),
    box-shadow 200ms var(--cdn-ease-out);
}
.cdn-tile-button:hover {
  transform: translateY(-3px);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.12);
}
```

- [ ] **Step 2: Extend the reduced-motion block**

Find the existing block:

```css
@media (prefers-reduced-motion: reduce) {
  .cdn-meter-fill {
    transition: background-color 200ms ease;
  }
}
```

Replace it with:

```css
@media (prefers-reduced-motion: reduce) {
  .cdn-meter-fill {
    transition: background-color 200ms ease;
  }
  .cdn-tile-button {
    transition: none;
  }
  .cdn-tile-button:hover {
    transform: none;
    box-shadow: none;
  }
}
```

- [ ] **Step 3: Verify the build compiles the CSS**

Run: `npm run build`
Expected: exit 0, build completes (pre-existing Polaris `@media ... and print` and
dynamic-import warnings are unrelated and OK).

- [ ] **Step 4: Commit**

```bash
git add app/components/calderyn/calderyn.css
git commit -m "components/calderyn: hover-lift on clickable StatTiles"
```

---

## Task 4: Fade-in stagger CSS + dashboard wiring

**Files:**
- Modify: `app/components/calderyn/calderyn.css` (add stagger rules + keyframe; extend reduced-motion block)
- Modify: `app/routes/app._index.tsx` (wrap the stat-row `InlineGrid`)

- [ ] **Step 1: Add the stagger CSS**

Append to `app/components/calderyn/calderyn.css` (before the `@media (prefers-reduced-motion)` block):

```css
/* Dashboard stat-row mount stagger.
   .cdn-stat-row wraps the InlineGrid; "> * > *" targets each tile (grid item).
   fill-mode: backwards hides tiles during their delay, then reverts transform to
   base after the run — leaving .cdn-tile-button:hover's transform free. */
.cdn-stat-row > * > * {
  animation: cdnRise 420ms var(--cdn-ease-out) backwards;
}
.cdn-stat-row > * > *:nth-child(1) {
  animation-delay: 0ms;
}
.cdn-stat-row > * > *:nth-child(2) {
  animation-delay: 90ms;
}
.cdn-stat-row > * > *:nth-child(3) {
  animation-delay: 180ms;
}
.cdn-stat-row > * > *:nth-child(4) {
  animation-delay: 270ms;
}
@keyframes cdnRise {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

- [ ] **Step 2: Disable the stagger under reduced motion**

In the `@media (prefers-reduced-motion: reduce)` block (now containing the
hover-lift resets from Task 3), add the stagger reset so the final block reads:

```css
@media (prefers-reduced-motion: reduce) {
  .cdn-meter-fill {
    transition: background-color 200ms ease;
  }
  .cdn-tile-button {
    transition: none;
  }
  .cdn-tile-button:hover {
    transform: none;
    box-shadow: none;
  }
  .cdn-stat-row > * > * {
    animation: none;
  }
}
```

- [ ] **Step 3: Wrap the stat row in the dashboard**

In `app/routes/app._index.tsx`, find the stat row:

```tsx
        {/* Stat row */}
        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
```

and its matching `</InlineGrid>` (immediately after the fourth `StatTile`). Wrap
the whole `InlineGrid` in a div:

```tsx
        {/* Stat row */}
        <div className="cdn-stat-row">
          <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
            {/* ...the four StatTile elements stay exactly as they are... */}
          </InlineGrid>
        </div>
```

Do not change the `StatTile` children — only add the wrapping `<div className="cdn-stat-row">` and its closing `</div>`, and indent the block accordingly.

- [ ] **Step 4: Verify typecheck + build**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/components/calderyn/calderyn.css app/routes/app._index.tsx
git commit -m "routes/app._index: fade-in stagger on the dashboard stat row"
```

---

## Task 5: Pre-commit gate + manual verification

**Files:** none (verification only).

This satisfies the CLAUDE.md mandatory gate (StatTile/Polaris UI = major commit).

- [ ] **Step 1: Run the full eval pipeline**

Run each, in order; each must be green:

```bash
npm run typecheck   # exit 0
npm run lint        # exit 0 (framework deprecation notice is OK)
npm run test        # exit 0 — countup.test.ts passes
npm run build       # exit 0
```

- [ ] **Step 2: Patch sanity**

```bash
git diff --stat origin/main
git diff --check
```

Expected: only the six files from this plan touched; `git diff --check` clean; no
stray `console.log`, `.only`, or commented-out blocks.

- [ ] **Step 3: Manual check in the running app**

Run: `npm run dev`, open the embedded dashboard, and confirm:
- Tiles rise + shadow on hover.
- The four stat numbers tick up from 0 on load (e.g. Open alerts → 15, ROAS → 0.8×).
- The four cards fade/slide in left-to-right on load.
- Enable OS "reduce motion", reload: all three are disabled (instant final state),
  numbers show immediately, no hover transform.

- [ ] **Step 4 (optional): code review**

Run `/code-review` on the working tree and resolve any blockers before merging /
pushing to main.

---

## Self-review notes

- **Spec coverage:** Hover-lift (Task 3), count-up incl. mixed-format parsing
  (Tasks 1–2), stagger (Task 4), reduced-motion for all three (Tasks 2/3/4),
  motion-token timing (Tasks 2–4), testing (Task 1 + Task 5). "Free with Polaris"
  and meter "D" are out of scope per spec — no tasks, intentional.
- **Type consistency:** `ParsedCount`, `parseCountValue`, `formatCount`,
  `easeOutCubic` are defined in Task 1 and used unchanged in Tasks 1–2. `CountUp`
  prop is `value: string` in Task 2 component and call site.
- **Transform collision:** resolved via `animation-fill-mode: backwards` (Task 4)
  so hover-lift's `transform` (Task 3) is not locked by a filled entrance animation.
