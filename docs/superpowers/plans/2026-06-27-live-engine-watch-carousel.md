# Live Engine Watch Carousel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each Watching rectangle (Inventory / Ads / Pricing / Retention) in the Live Engine hero a vertical roll/slot ticker that cycles real names of what Calderyn is scanning.

**Architecture:** A pure server helper (`buildWatchScan`) turns already-loaded SKU + campaign data into four bounded name-lists on the `LiveEnginePageData` contract. The hero's GSAP `HeroEngine` rolls each row's list (one name up/out, next in from below) every ~2.4s, pausing during flag/approve animations. Both surfaces (dashboard `Dashboard.tsx` and embedded `LiveEngineView.tsx`) render the same `AutopilotHero`, so one implementation covers both — they just pass the new prop.

**Tech Stack:** TypeScript (strict, ESM), Remix, React 18, GSAP + `@gsap/react`, Vitest, Supabase (via `calderynClient`).

## Global Constraints

- TypeScript only; no `any` without written justification — prefer `unknown` + narrowing. `tsc --noEmit` is authoritative.
- `.server.ts` modules are server-only; never import them from a client/browser module. `watch-scan.ts` must stay pure (no `.server` imports) so the browser-side hero can import its types.
- Loader truthfulness policy: show only real state, never fabricated activity. Real names only; the aspect-fallback lines describe real activities (allowed). No invented cohort/customer names.
- Forbidden in workflow/runtime helpers: `Date.now()` / `Math.random()` inside the pure helper — keep `buildWatchScan` deterministic.
- Browser-source hygiene: no AI/tool/provenance markers, no design-tool/handoff names, no dev overlays in any browser-visible code or comment.
- Dashboard icons via `CDIcon`/Lucide; embedded admin via Polaris — but this change adds no icons.
- Pre-commit gate (major commit): `/code-review`, then `npm run typecheck` → 0, `npm run lint` (`--max-warnings=0` on touched files) → 0, `npm run build` → 0. Paste evidence; never assert success without it.
- All work happens in the worktree `feat+live-engine-overview` (branch `freshdeploy`).

---

### Task 1: Pure `buildWatchScan` helper + contract field

**Files:**
- Modify: `app/lib/calibration/live-engine-types.ts` (add `watchScan` to `LiveEnginePageData`)
- Create: `app/lib/calibration/watch-scan.ts`
- Test: `app/lib/calibration/__tests__/watch-scan.test.ts`

**Interfaces:**
- Produces: `buildWatchScan(skus: ScanSku[], campaigns: ScanCampaign[]): WatchScan`, `scanLineFor(list: string[], aspects: string[], idx: number): string`, types `WatchScan`, `ScanSku` (`{ title: string; velocity?: number | null }`), `ScanCampaign` (`{ name: string }`). `WatchScan = LiveEnginePageData["watchScan"]`.

- [ ] **Step 1: Add the contract field**

In `app/lib/calibration/live-engine-types.ts`, inside `interface LiveEnginePageData`, add after `predictions`:

```ts
  /** Real names currently being scanned, per Watching group (bounded ~8 each).
   *  Empty lists are normal (new store) — the hero falls back to a neutral
   *  activity line. Never fabricated; `ret` is reserved (no real source yet). */
  watchScan: {
    inv: string[];
    ads: string[];
    price: string[];
    ret: string[];
  };
```

- [ ] **Step 2: Write the failing test**

Create `app/lib/calibration/__tests__/watch-scan.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildWatchScan, scanLineFor } from "../watch-scan";

describe("buildWatchScan", () => {
  it("maps titles to inv and campaign names to ads, ret stays empty", () => {
    const out = buildWatchScan(
      [{ title: "Summit Logo Tee" }, { title: "Cascade Rain Shell" }],
      [{ name: "Meta · Retargeting" }],
    );
    expect(out.inv).toEqual(["Summit Logo Tee", "Cascade Rain Shell"]);
    expect(out.ads).toEqual(["Meta · Retargeting"]);
    expect(out.ret).toEqual([]);
  });

  it("caps each list at 8, trims, and dedupes case-insensitively", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `Item ${i}` }));
    const out = buildWatchScan(
      [{ title: "  Tee  " }, { title: "tee" }, ...many],
      [],
    );
    expect(out.inv).toHaveLength(8);
    expect(out.inv[0]).toBe("Tee");
    expect(out.inv.filter((n) => n.toLowerCase() === "tee")).toHaveLength(1);
  });

  it("orders price by velocity desc so its lead differs from inv", () => {
    const out = buildWatchScan(
      [
        { title: "A", velocity: 1 },
        { title: "B", velocity: 9 },
        { title: "C", velocity: 5 },
      ],
      [],
    );
    expect(out.inv[0]).toBe("A");
    expect(out.price[0]).toBe("B");
  });

  it("rotates price when velocity order matches inv, so they never look identical", () => {
    const out = buildWatchScan(
      [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }],
      [],
    );
    expect(out.price).not.toEqual(out.inv);
    expect([...out.price].sort()).toEqual([...out.inv].sort());
  });

  it("returns all-empty lists for empty inputs", () => {
    expect(buildWatchScan([], [])).toEqual({ inv: [], ads: [], price: [], ret: [] });
  });
});

describe("scanLineFor", () => {
  it("cycles list names by index", () => {
    expect(scanLineFor(["a", "b"], ["x"], 0)).toBe("a");
    expect(scanLineFor(["a", "b"], ["x"], 3)).toBe("b");
  });
  it("falls back to aspect lines when the list is empty", () => {
    expect(scanLineFor([], ["x", "y"], 1)).toBe("y");
  });
  it("returns empty string when both are empty", () => {
    expect(scanLineFor([], [], 0)).toBe("");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run app/lib/calibration/__tests__/watch-scan.test.ts`
Expected: FAIL — cannot find module `../watch-scan`.

- [ ] **Step 4: Implement the helper**

Create `app/lib/calibration/watch-scan.ts`:

```ts
// Pure (browser-safe, no .server imports) builder for the Live Engine hero's
// per-rectangle scan tickers. Turns real SKU + campaign data into bounded name
// lists. Deterministic — no Date.now()/Math.random() — so it is unit-testable
// and stable across renders. `ret` is reserved: there is no real cohort source
// yet, so it stays empty and the hero falls back to a neutral activity line.
import type { LiveEnginePageData } from "./live-engine-types";

export type WatchScan = LiveEnginePageData["watchScan"];
export interface ScanSku {
  title: string;
  velocity?: number | null;
}
export interface ScanCampaign {
  name: string;
}

const CAP = 8;

function clean(names: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const s = (raw ?? "").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= CAP) break;
  }
  return out;
}

export function buildWatchScan(skus: ScanSku[], campaigns: ScanCampaign[]): WatchScan {
  const inv = clean(skus.map((s) => s.title));
  const byVelocity = [...skus].sort((a, b) => (b.velocity ?? 0) - (a.velocity ?? 0));
  let price = clean(byVelocity.map((s) => s.title));
  // Guarantee a visual difference from inv even when velocity is flat/equal:
  // rotate by half-length so the two rows never lead with the same name.
  if (price.length > 1 && price.every((n, i) => n === inv[i])) {
    const k = Math.floor(price.length / 2) || 1;
    price = [...price.slice(k), ...price.slice(0, k)];
  }
  const ads = clean(campaigns.map((c) => c.name));
  return { inv, price, ads, ret: [] };
}

/** Name to show in a row at a given tick: the list item (cycled), else an
 *  aspect-activity line (cycled), else empty. */
export function scanLineFor(list: string[], aspects: string[], idx: number): string {
  if (list.length) return list[((idx % list.length) + list.length) % list.length];
  if (aspects.length) return aspects[((idx % aspects.length) + aspects.length) % aspects.length];
  return "";
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run app/lib/calibration/__tests__/watch-scan.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add app/lib/calibration/live-engine-types.ts app/lib/calibration/watch-scan.ts app/lib/calibration/__tests__/watch-scan.test.ts
git commit -m "live-engine: watchScan contract field + pure builder"
```

---

### Task 2: Loader fills `watchScan` (real SKU + campaign data)

**Files:**
- Modify: `app/lib/calibration/live-engine-page.server.ts` (allSettled batch, destructure, `EMPTY`, return object)
- Test: `app/lib/calibration/__tests__/live-engine-page.test.ts` (add a case)

**Interfaces:**
- Consumes: `buildWatchScan` (Task 1), `client.skus.list()`, `client.campaigns.list()`.
- Produces: `LiveEnginePageData.watchScan` populated on both `EMPTY` and the success path.

- [ ] **Step 1: Import the helper**

In `app/lib/calibration/live-engine-page.server.ts`, add near the other imports (after the `./progress` import):

```ts
import { buildWatchScan } from "./watch-scan";
```

- [ ] **Step 2: Add `watchScan` to the `EMPTY` constant**

In the `EMPTY: LiveEnginePageData` object, add:

```ts
  watchScan: { inv: [], ads: [], price: [], ret: [] },
```

- [ ] **Step 3: Add the campaigns read to the batch**

Replace the `Promise.allSettled([...])` destructuring head:

```ts
    const [summaryR, pairsR, calR, nearR, proposalsR, auditR, skusR, alertsR, gradesR] =
      await Promise.allSettled([
        client.calibration.liveEngine(),
        client.calibration.pairEvidence(),
        client.calibration.get(signal),
        client.calibration.nearGraduation(),
        client.queue.list(signal),
        client.audit.list(signal),
        client.skus.list(signal),
        client.alerts.list({ status: "open" }, signal),
        client.analytics.campaignGrades(signal),
      ]);
```

with (adds `campaignsR` + `client.campaigns.list`):

```ts
    const [summaryR, pairsR, calR, nearR, proposalsR, auditR, skusR, alertsR, gradesR, campaignsR] =
      await Promise.allSettled([
        client.calibration.liveEngine(),
        client.calibration.pairEvidence(),
        client.calibration.get(signal),
        client.calibration.nearGraduation(),
        client.queue.list(signal),
        client.audit.list(signal),
        client.skus.list(signal),
        client.alerts.list({ status: "open" }, signal),
        client.analytics.campaignGrades(signal),
        client.campaigns.list(signal),
      ]);
```

- [ ] **Step 4: Destructure + build `watchScan`**

After the line `const grades = gradesR.status === "fulfilled" ? gradesR.value : [];` add:

```ts
    const campaigns = campaignsR.status === "fulfilled" ? campaignsR.value : [];
    const watchScan = buildWatchScan(
      skus.map((s) => ({ title: s.title, velocity: s.velocity })),
      campaigns.map((c) => ({ name: c.name })),
    );
```

- [ ] **Step 5: Add `watchScan` to the returned object**

In the final `return { ... }` of the success path, add `watchScan,` alongside `predictions`.

- [ ] **Step 6: Add a loader test case**

In `app/lib/calibration/__tests__/live-engine-page.test.ts`, add a test that stubs `client.skus.list` to return `[{ title: "Summit Logo Tee", velocity: 3, ... }]` and `client.campaigns.list` to return `[{ name: "Meta · Retargeting", ... }]`, then asserts:

```ts
expect(data.watchScan.inv).toContain("Summit Logo Tee");
expect(data.watchScan.ads).toContain("Meta · Retargeting");
expect(data.watchScan.ret).toEqual([]);
```

Follow the file's existing client-stub pattern (chainable mock). If `campaigns.list` is not already stubbed there, add it returning `[]` by default so other tests stay green.

- [ ] **Step 7: Run tests**

Run: `npx vitest run app/lib/calibration/__tests__/live-engine-page.test.ts`
Expected: PASS (new + existing cases).

- [ ] **Step 8: Commit**

```bash
git add app/lib/calibration/live-engine-page.server.ts app/lib/calibration/__tests__/live-engine-page.test.ts
git commit -m "live-engine: build watchScan from real SKUs + campaigns in loader"
```

---

### Task 3: Hero markup — scan ticker slot + `watchScan` prop

**Files:**
- Modify: `app/components/dashboard/hero/AutopilotHero.tsx`

**Interfaces:**
- Consumes: `LiveEnginePageData["watchScan"]` shape as a prop; calls `engine.setScan(...)` (Task 4).
- Produces: a `[data-watch-scan]` element per Watching row; `AutopilotHeroProps.watchScan`.

- [ ] **Step 1: Add the prop to the interface**

In `AutopilotHeroProps`, add:

```ts
  /** Real names being scanned per group; drives the per-row roll ticker. */
  watchScan: { inv: string[]; ads: string[]; price: string[]; ret: string[] };
```

- [ ] **Step 2: Destructure the prop**

In `export default function AutopilotHero(props)`, add `watchScan` to the destructure list.

- [ ] **Step 3: Render the ticker slot in each Watching row**

Inside the row's flexible middle container (the `<div style={{ flex: "1 1 auto", minWidth: 0, position: "relative", height: 18, overflow: "hidden", zIndex: 1 }}>` that holds `[data-watch-sub]`), add a sibling BEFORE the `[data-watch-sub]` span:

```tsx
                        <span
                          data-watch-scan
                          style={{
                            display: "flex",
                            alignItems: "center",
                            position: "absolute",
                            inset: 0,
                            fontSize: 11.5,
                            fontWeight: 500,
                            lineHeight: "18px",
                            color: "var(--ha-ink-3)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            willChange: "transform",
                          }}
                        />
```

(Keep `[data-watch-sub]` exactly as-is. The scan span is visible by default; the sub overlays it during flag/dock — `setSub` hides the scan, the dock settle restores it.)

- [ ] **Step 4: Pass the lists into the engine on setup**

In the `useGSAP` body, after `engine.setFlags(flaggedGroups);` and before `engine.startWatch();`, add:

```ts
      engine.setScan(watchScan);
```

- [ ] **Step 5: React to data changes**

Add a reactive effect next to the other `useEffect` blocks:

```ts
  useEffect(() => { engineRef.current?.setScan(watchScan); }, [watchScan]);
```

- [ ] **Step 6: Verify it compiles**

Run: `npm run typecheck`
Expected: type errors ONLY about `engine.setScan` not existing yet (added in Task 4). If any other error, fix it. (This task and Task 4 commit together — see Task 4 Step 8.)

---

### Task 4: Motion engine — `setScan`, roll loop, pause/resume

**Files:**
- Modify: `app/components/dashboard/hero/hero-motion.ts`

**Interfaces:**
- Consumes: `scanLineFor` (Task 1), existing `wait`, `q`, `reduced`, `EMPH`, `watchRows`, `busy`, `destroyed`.
- Produces: `HeroEngine.setScan(lists)`, internal `startScan`/`stopScan`/`renderScan`/`scanStep`.

- [ ] **Step 1: Import the pure picker + add the aspect map**

Add to the imports:

```ts
import { scanLineFor } from "../../../lib/calibration/watch-scan";
```

Near the other module constants (after `GROUP_ICO`), add:

```ts
/** Neutral, truthful activity lines shown when a group has no names to roll. */
const SCAN_ASPECTS: Record<WatchGroup, string[]> = {
  inv: ["Checking stock levels", "Stock vs forecast"],
  ads: ["Checking ROAS", "Budget pacing"],
  price: ["Checking margins", "Price vs market"],
  ret: ["Checking repeat orders", "Churn signals"],
};
```

- [ ] **Step 2: Add scan state fields**

In the class field block (after `private watchI = -1;`), add:

```ts
  private scan: Record<WatchGroup, string[]> = { inv: [], ads: [], price: [], ret: [] };
  private scanTick = 0;
```

- [ ] **Step 3: Add `setScan` + render + loop**

Add these methods near `startWatch` / `setRowScan`:

```ts
  /** Provide the real per-group names. Renders the current line on each row
   *  immediately (no animation) so a data refresh never blanks the ticker. */
  setScan(lists: Record<WatchGroup, string[]>): void {
    this.scan = lists;
    this.watchRows().forEach((row) => this.renderScan(row, false));
  }

  private scanTextFor(g: WatchGroup): string {
    return scanLineFor(this.scan[g] ?? [], SCAN_ASPECTS[g] ?? [], this.scanTick);
  }

  private renderScan(row: HTMLElement, animate: boolean): void {
    const el = q<HTMLElement>(row, "[data-watch-scan]");
    const g = row.getAttribute("data-group") as WatchGroup | null;
    if (!el || !g) return;
    const next = this.scanTextFor(g);
    if (!animate || reduced()) {
      el.textContent = next;
      gsap.set(el, { y: 0, autoAlpha: 1 });
      return;
    }
    const tl = gsap.timeline();
    tl.to(el, { y: -10, autoAlpha: 0, duration: 0.22, ease: "power1.in" })
      .add(() => { el.textContent = next; })
      .fromTo(el, { y: 10, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.3, ease: EMPH });
  }

  private startScan(): void {
    if (reduced()) return;
    const step = () => {
      if (this.destroyed || this.busy) return;
      this.scanTick += 1;
      // Small per-row stagger for a cascade, but only on idle (non-flagged) rows.
      this.watchRows().forEach((row, k) => {
        const g = row.getAttribute("data-group") as WatchGroup | null;
        const sub = q<HTMLElement>(row, "[data-watch-sub]");
        const subShown = !!sub && sub.style.display !== "none";
        if (g && !subShown) this.wait(0.08 * k, () => this.renderScan(row, true));
      });
      this.wait(2.4, step);
    };
    this.wait(2.4, step);
  }
```

- [ ] **Step 4: Start scan with the watch loop**

At the END of `startWatch()` (after the existing `this.wait(0.5, step);`), add:

```ts
    this.startScan();
```

`stopWatch()` already kills every `this.timers` entry (which includes the scan `wait`s) and `resumeWatch()` calls `startWatch()` again — so scan pauses during the dock sequence and resumes after, no extra wiring needed.

- [ ] **Step 5: Hide the ticker while a sub (flag/dock) is shown; restore on settle**

In `setSub(...)`, the existing `if (strip) strip.style.opacity = "0";` targets the dead `[data-feed-strip]`. Replace that lookup to target the scan element:

```ts
    const scanEl = q<HTMLElement>(row, "[data-watch-scan]");
    ...
    if (scanEl) scanEl.style.visibility = "hidden";
```

(Remove the now-dead `const strip = q...[data-feed-strip]` line and its `strip.style.opacity` use.)

In `runDockSequence`, at the settle block where it sets `if (sub) sub.style.display = "none";` (the final `this.wait(1.4, ...)`), restore the ticker right after:

```ts
          const scanEl = q<HTMLElement>(row, "[data-watch-scan]");
          if (scanEl) { scanEl.style.visibility = "visible"; gsap.set(scanEl, { y: 0, autoAlpha: 1 }); }
```

- [ ] **Step 6: Keep the ticker correct when flags toggle**

In `setFlags(...)`, at the end of the `.forEach`, after setting the status text, hide the ticker on flagged rows and show it on clear rows:

```ts
      const scanEl = q<HTMLElement>(row, "[data-watch-scan]");
      if (scanEl) {
        scanEl.style.visibility = flagged ? "hidden" : "visible";
        if (!flagged) this.renderScan(row, false);
      }
```

(When flagged, `[data-watch-sub]` carries the flagged item via the existing dock/flag path; the ambient ticker steps aside.)

- [ ] **Step 7: Run typecheck + build**

Run: `npm run typecheck`
Expected: PASS (0 errors, including Task 3's `setScan` call now resolved).

Run: `npm run build`
Expected: exit 0 (Remix + Vite build completes; client-bundle verifier passes).

- [ ] **Step 8: Commit (Tasks 3 + 4 together)**

```bash
git add app/components/dashboard/hero/AutopilotHero.tsx app/components/dashboard/hero/hero-motion.ts
git commit -m "live-engine hero: per-row scan ticker (roll/slot swap, pause on flag/dock)"
```

---

### Task 5: Wire the prop through both surfaces

**Files:**
- Modify: `app/components/dashboard/screens/Dashboard.tsx`
- Modify: `app/components/calderyn/LiveEngineView.tsx`

**Interfaces:**
- Consumes: `data.watchScan` (Task 2) → `AutopilotHero` `watchScan` prop (Task 3).

- [ ] **Step 1: Dashboard surface**

In `Dashboard.tsx`, in the `<AutopilotHero ... />` JSX, add the prop (next to `flaggedGroups`):

```tsx
            watchScan={data.watchScan}
```

- [ ] **Step 2: Embedded surface**

In `LiveEngineView.tsx`, find its `<AutopilotHero ... />` usage (~line 663) and add the same prop, sourcing from the same page data object it already destructures:

```tsx
            watchScan={data.watchScan}
```

(If the embedded component names the data variable differently, use that variable — it is the `LiveEnginePageData` from the shared loader.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS — `AutopilotHero` now receives `watchScan` on both surfaces (the prop is required, so a miss would error here).

- [ ] **Step 4: Commit**

```bash
git add app/components/dashboard/screens/Dashboard.tsx app/components/calderyn/LiveEngineView.tsx
git commit -m "live-engine: pass watchScan to hero on both surfaces"
```

---

### Task 6: Full gate + manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full eval pipeline**

```bash
npm run typecheck   # exit 0
npm run lint        # exit 0, no warnings on touched files
npm run build       # exit 0
npx vitest run app/lib/calibration/__tests__/watch-scan.test.ts app/lib/calibration/__tests__/live-engine-page.test.ts
```

Paste each result. If any fails, stop and fix the root cause (no `--no-verify`, no disables).

- [ ] **Step 2: `/code-review` the working tree**

Resolve every blocker; downgrade nits with a one-line justification.

- [ ] **Step 3: Manual verify (seeded demo store)**

Run the app (or check prod preview) against `calderyn-review-store` / `calderyn-test`:
- Inventory rolls real product names; Ads rolls real campaign names; Pricing rolls products in a different order; Retention rolls the aspect lines.
- Approving a pending item: that row's ticker pauses during the dock/run animation, then resumes.
- Toggle OS "reduce motion": names are static, no rolling, on both dashboard and embedded.
- Empty/new store path: every row shows aspect lines, no blanks.

- [ ] **Step 4: Patch sanity**

`git diff --stat` and `git diff --check` clean; no stray `console.log`, `.only`, TODO(me), commented-out blocks, or provenance markers in the diff.

---

## Self-Review

**Spec coverage:**
- Contract field → Task 1. ✓
- Real per-category sources (inv/price/ads real, ret reserved→fallback) → Tasks 1–2. ✓
- Vertical roll/slot swap motion → Task 4 (`renderScan`). ✓
- Pause during flag/approve, resume after → Task 4 (Steps 4–6). ✓
- Aspect fallback (truthful, never blank) → Task 1 (`scanLineFor`) + Task 4 (`SCAN_ASPECTS`). ✓
- Reduced-motion = static → Task 4 (`renderScan`/`startScan` `reduced()` guards). ✓
- Both surfaces via shared component → Task 5. ✓
- No height change (single-line, absolute-inset ticker) → Task 3. ✓
- Remove dead `[data-feed-strip]` → Task 4 Step 5. ✓
- Tests for pure builder + loader → Tasks 1–2. ✓

**Placeholder scan:** No TBD/TODO; all code blocks are concrete. ✓

**Type consistency:** `watchScan` shape identical across contract (Task 1), `EMPTY`/return (Task 2), prop (Task 3), `setScan(lists: Record<WatchGroup,string[]>)` (Task 4) — `Record<WatchGroup,string[]>` and `{inv,ads,price,ret: string[]}` are structurally identical. `scanLineFor`/`buildWatchScan` signatures match Task 1 ↔ Tasks 2/4. ✓

**Note / confirm during impl:** Task 2 assumes `client.campaigns.list()` returns objects with `.name` and `SKU` has `.velocity` (both verified in `calderyn.server.ts`). Task 5 assumes `LiveEngineView` has the page data in scope where the hero renders (verified: it renders the shared `AutopilotHero` from the same loader). Task 2 Step 6 must follow the existing client-stub style in the test file.
