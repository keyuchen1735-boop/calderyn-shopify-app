# Live Engine Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the dashboard Overview as the "Live Engine" (animated hero + Calderyn Log + Autopilot features/Inspector) wired to the real engine, move all current Overview content to Analytics, re-theme the dashboard black/white, and mirror the experience onto the embedded Shopify home.

**Architecture:** This is a **restore + refine + extend** job, not a from-scratch build. Commit `794978c` already implemented every component against the still-current `LiveEnginePageData` contract; we restore those files, adapt them to the current data layer, re-derive visuals/motion pixel-for-pixel from the Claude Design handoff, then add the new pieces (global re-theme, Analytics absorption, pending-item Inspector, embedded mirror). The page (Calderyn Log = data/state) talks to the GSAP hero (motion) through a typed `window` CustomEvent seam (`le-dock`/`le-calibrate`/`le-openreason`/`le-did`) carrying **real** data fired on **real** endpoint success.

**Tech Stack:** Remix (Vite) + React 18, TypeScript (strict). Dashboard: custom `cd-*` components + `app/styles/dashboard.css` tokens, `CDIcon`/lucide. Embedded: Polaris + App Bridge + `@shopify/polaris-icons` + `app/components/calderyn/*`. Motion: GSAP 3.15.0 + @gsap/react 2.1.2 (via installed gsap-skills). Tests: `vitest run`.

## Global Constraints

_(Copied from the spec. Every task implicitly includes these.)_

- **No env / deploy / Remix-version / package-override changes.** Only new deps: `gsap@^3.15.0`, `@gsap/react@^2.1.2`. Do NOT touch `@remix-run/*` or `@vercel/remix` pins (single-fetch SSR breaks app-wide otherwise).
- **Both surfaces ship in this task** (dashboard parity is mandatory). If only one can land, say so explicitly + leave a TODO.
- **Re-theme is global; only the brand `--accent` flips** to near-black (`#1A1A1C` light) / near-white (`#F2F2F4` dark). Semantic `--red #E0352B` / `--green #248A3D` / `--orange #C93B00` / `--yellow-fg #946300` keep their meaning.
- **Fidelity rules:** steps 3 & 5 of the handoff use the SAME chip-arc; intake outline traces the card's REAL bounding rect (+~2px), not an `inset:-2px` child; **never** sonar/pulse/radar/scanner-circle motifs — only scans/sweeps/draws/arcs; system font stack (no condensed eyebrow font); title state is a fade not a slide; `prefers-reduced-motion` ⇒ instant states via `gsap.matchMedia()`; reasoning toggle guards re-entrancy.
- **Browser-visible source hygiene:** no AI/prototype/design-tool provenance comments or identifiers; never ship `support.js` or any `.dc.html`; no dev overlays/HMR/wildcard postMessage; keep `build.sourcemap` off; `npm run build` must keep `scripts/verify-client-bundle.mjs` green (fix markers, don't weaken the verifier).
- **Repo rules:** `.server` files never imported from client modules; loaders read-only, mutations in actions, `redirect()` after success; embedded routes call `authenticate.admin(request)` and use `@shopify/polaris-icons` (not Lucide); dashboard uses `CDIcon`.
- **Design source of truth:** claude.ai Design project `3fae1b7a-423f-4bb9-8441-9239db64d3bc` — pull files with DesignSync `get_file` (`Calderyn Webapp.dc.html`, `design_handoff_live_engine/AutopilotHero.dc.html`, `design_handoff_live_engine/css/dashboard.css` + `dashboard-utils.css`, `live-engine-kit/*`). Reverted scaffold = git `794978c`.
- **Pre-commit gate before any commit beyond docs:** `/code-review` → patch sanity → `npm run typecheck` (0) → `npm run lint` (0, `--max-warnings=0` on touched files) → `npm run build` (0, incl. verifier) → `vitest run` (0). Show evidence; never assert success without it.

---

## File Structure

**Restore from `794978c` (then adapt):**
- `app/components/dashboard/engine-events.ts` — typed CustomEvent seam (`WatchGroup`, `LeDockDetail`, `LeCalibrateDetail`, `LeDidDetail`, `emitEngine`, `onEngine`).
- `app/components/dashboard/overview/features-model.ts` — `FeatureRowVM`, `FeatureGroupVM`, `buildFeatureGroups`, `countEnabled`, `countTotal`, `flaggedGroups`.
- `app/components/dashboard/hero/AutopilotHero.tsx` — hero component (`AutopilotHeroProps`).
- `app/components/dashboard/hero/hero-motion.ts` — `HeroEngine` class + `groupForActionKind`, `foldAndDock`.
- `app/components/dashboard/overview/CalderynLog.tsx` — merged feed + Approve/Deny.
- `app/components/dashboard/overview/AutopilotFeatures.tsx` — collapsible feature groups + toggles.
- `app/components/dashboard/overview/InspectorPanel.tsx` — the "why" explainer.

**New:**
- `app/components/dashboard/overview/inspector-vm.ts` — `InspectorVM` + `inspectorFromTrace()` + `inspectorFromPending()` (unifies history + pending-proposal inspector).
- `app/components/calderyn/LiveEngineHero.tsx` — embedded Polaris hero.
- `app/components/calderyn/CalderynLog.tsx` — embedded Polaris log.
- `app/routes/app.analytics.tsx` — embedded analytics (moved home content).

**Modify:**
- `app/styles/dashboard.css` — black/white token re-theme + `.ha-*` hero styles.
- `app/components/dashboard/screens/Dashboard.tsx` — becomes Live Engine Overview.
- `app/components/dashboard/screens/Analytics.tsx` — absorb moved Overview cards.
- `app/components/dashboard/DashboardApp.tsx` — ensure `liveEngine` + `actionQueue` available to Overview; rail-swap state.
- `app/lib/dashboard/client.ts` / `app/components/dashboard/view-models.ts` — small glue only if a field is missing.
- `app/routes/app._index.tsx` — becomes embedded Live Engine home.
- `app/routes/app.engine.tsx` — thin redirect to `/app`.
- `package.json` — add the two GSAP deps.

---

## Task 1: GSAP deps + restore the event seam (pure, tested)

**Files:**
- Modify: `package.json` (dependencies)
- Create: `app/components/dashboard/engine-events.ts` (restore from `794978c`)
- Test: `app/components/dashboard/__tests__/engine-events.test.ts`

**Interfaces — Produces:**
```ts
export type WatchGroup = "inv" | "ads" | "price" | "ret";
export interface LeDockDetail { group: WatchGroup; label: string; money?: string; moneyShort?: string; steps?: string[]; icon?: string; }
export interface LeCalibrateDetail { kind: "approve" | "deny"; delta?: number; }  // delta ADDED vs 794978c
export interface LeDidDetail { icon?: string; title: string; steps?: string[]; money?: string; moneyShort?: string; }
export function emitEngine<K extends keyof LeEventMap>(type: K, detail?: LeEventMap[K]): void;
export function onEngine<K extends keyof LeEventMap>(type: K, handler: (detail: LeEventMap[K]) => void): () => void;
```

- [ ] **Step 1: Add deps.** Edit `package.json` dependencies, adding `"gsap": "^3.15.0"` and `"@gsap/react": "^2.1.2"` (alphabetical order in the block). Run `npm install`. Expected: adds 2 packages, exit 0.

- [ ] **Step 2: Restore the file.** Run:
```bash
mkdir -p app/components/dashboard/overview app/components/dashboard/hero
git show 794978c:app/components/dashboard/engine-events.ts > app/components/dashboard/engine-events.ts
```
Then add the optional `delta?: number` field to `LeCalibrateDetail` (used to bump the ring by the real receipt delta). Verify it contains `emitEngine`, `onEngine`, `WatchGroup`, and is SSR-safe (`typeof window === "undefined"` guard in `emitEngine`/`onEngine`).

- [ ] **Step 3: Write the failing test.**
```ts
// app/components/dashboard/__tests__/engine-events.test.ts
import { describe, it, expect, vi } from "vitest";
import { emitEngine, onEngine } from "../engine-events";

describe("engine-events", () => {
  it("delivers a typed detail to a subscriber", () => {
    const seen: unknown[] = [];
    const off = onEngine("le-dock", (d) => seen.push(d));
    emitEngine("le-dock", { group: "ads", label: "Pause campaign", money: "$420" });
    expect(seen).toEqual([{ group: "ads", label: "Pause campaign", money: "$420" }]);
    off();
  });
  it("unsubscribe stops delivery", () => {
    const fn = vi.fn();
    const off = onEngine("le-calibrate", fn);
    off();
    emitEngine("le-calibrate", { kind: "approve", delta: 6 });
    expect(fn).not.toHaveBeenCalled();
  });
  it("emit is a no-op with no subscribers (no throw)", () => {
    expect(() => emitEngine("le-openreason")).not.toThrow();
  });
});
```

- [ ] **Step 4: Run it.** `npx vitest run app/components/dashboard/__tests__/engine-events.test.ts` → PASS (restored impl already satisfies it). If FAIL, fix the restored file (most likely the `delta` field or an SSR guard).

- [ ] **Step 5: Typecheck + commit.** `npm run typecheck` → 0. Then:
```bash
git add package.json package-lock.json app/components/dashboard/engine-events.ts app/components/dashboard/__tests__/engine-events.test.ts
git commit -m "feat(live-engine): add gsap deps + typed engine-event seam"
```

---

## Task 2: Global black/white re-theme

**Files:**
- Modify: `app/styles/dashboard.css` (token blocks for `.cd-root` light + `.cd-root.cd-dark`)
- Modify: any dashboard component/screen with a hardcoded blue (sweep)

**Interfaces:** none (CSS tokens). Downstream tasks consume `var(--accent)` etc.

- [ ] **Step 1: Pull the design tokens.** DesignSync `get_file` `design_handoff_live_engine/css/dashboard.css`. Read its `:root`/`.cd-root` and `.cd-dark` token blocks.

- [ ] **Step 2: Replace the token values** in `app/styles/dashboard.css`:
  - Light `.cd-root`: `--accent:#1A1A1C; --on-accent:#FFFFFF; --bg:#F5F5F7; --card-solid:#FFFFFF; --text-1:#1D1D1F; --text-2:#6E6E73; --text-3:#AEAEB2; --hairline:rgba(0,0,0,.045); --hairline-strong:rgba(0,0,0,.12); --radius:16px;` and the `--shadow-card` from the handoff README.
  - Dark `.cd-root.cd-dark`: `--accent:#F2F2F4; --on-accent:#16161A; --bg:#1C1C1E; --card-solid:#2C2C2E; --text-1:#F5F5F7; --text-2:#98989F; --text-3:#636366; --hairline:rgba(255,255,255,.07); --hairline-strong:rgba(255,255,255,.18);`
  - Keep semantic `--red/--green/--orange/--yellow-fg`. Keep any `--accent-bg` defined via `color-mix(... var(--accent) ...)` so it follows the new accent automatically.

- [ ] **Step 3: Sweep hardcoded blue.** `grep -rin "#24556E\|#24556e" app/components/dashboard app/styles` and replace literal occurrences with `var(--accent)` (or a semantic token if the intent was status, not brand). Re-check `app/components/dashboard/icons.tsx` and chart fills.

- [ ] **Step 4: Build.** `npm run build` → exit 0 (verifier green).

- [ ] **Step 5: Visual check + commit.** `/run` the dashboard; spot-check Overview/Alerts/Campaigns/Settings in light AND dark — accent is black/white, status colors intact, nothing unreadable. Then:
```bash
git add app/styles/dashboard.css app/components/dashboard
git commit -m "feat(dashboard): re-theme brand accent to black/white (light+dark)"
```

---

## Task 3: features-model + detector→domain helper (pure, tested)

**Files:**
- Create: `app/components/dashboard/overview/features-model.ts` (restore from `794978c`, then extend)
- Test: `app/components/dashboard/overview/__tests__/features-model.test.ts`

**Interfaces — Consumes:** `LiveEngineFeatureVM` (live-engine-types), `QueueProposalVM` (view-models), `WatchGroup` (Task 1), `DETECTOR_TO_ACTIONS` (labels). **Produces:**
```ts
export interface FeatureRowVM { detectorId: string; actionKind: string; name: string; enabled: boolean; locked: boolean; moneyCents: number; actions: number; }
export interface FeatureGroupVM { key: WatchGroup; label: string; icon: string; rows: FeatureRowVM[]; onCount: number; total: number; }
export function buildFeatureGroups(features: LiveEngineFeatureVM[], pending: QueueProposalVM[]): FeatureGroupVM[]; // order ["ads","inv","price","ret"]
export function countEnabled(groups: FeatureGroupVM[]): number;
export function countTotal(groups: FeatureGroupVM[]): number;
export function flaggedGroups(pending: QueueProposalVM[]): Set<WatchGroup>;
export function domainForDetector(detectorId: string): WatchGroup; // NEW — domain from detector, not text
```

- [ ] **Step 1: Restore.** `git show 794978c:app/components/dashboard/overview/features-model.ts > app/components/dashboard/overview/features-model.ts`. Read it; note how it currently assigns groups (the recon shows it grouped via a CATEGORY map / `groupForActionKind`).

- [ ] **Step 2: Add `domainForDetector`.** Replace text/action inference with a detector-driven map so flagged groups are correct. Add at top of the file:
```ts
// Domain each detector belongs to (drives Watching groups + flagged highlighting).
const DETECTOR_DOMAIN: Record<string, WatchGroup> = {
  // Ads / spend
  ad_tax_overload: "ads", campaign_below_breakeven: "ads", campaign_scaling_opportunity: "ads",
  // Inventory / fulfillment
  sku_stockout_vs_spend: "inv", regional_shortage_risk: "inv", regional_spend_starved_stock: "inv",
  reorder_timing: "inv", scaling_sku_fulfillment_risk: "inv", wrong_location_concentration: "inv",
  out_of_stock_live: "inv", inventory_untracked: "inv",
  // Pricing / margin
  negative_unit_economics: "price", margin_erosion: "price", cogs_drift: "price",
  priced_below_cost: "price", thin_margin: "price", missing_cost: "price",
  // Retention / shipping-economics
  return_rate_hidden_loss: "ret", free_shipping_leakage: "ret",
};
export function domainForDetector(detectorId: string): WatchGroup {
  return DETECTOR_DOMAIN[detectorId] ?? "ads";
}
```
Use `domainForDetector(p.detector_id)` inside `buildFeatureGroups` (for both graduated features and locked pending) and inside `flaggedGroups`.

- [ ] **Step 3: Write the failing tests.**
```ts
// app/components/dashboard/overview/__tests__/features-model.test.ts
import { describe, it, expect } from "vitest";
import { buildFeatureGroups, countEnabled, countTotal, flaggedGroups, domainForDetector } from "../features-model";
import type { LiveEngineFeatureVM } from "~/lib/calibration/live-engine-types";
import type { QueueProposalVM } from "~/components/dashboard/view-models";

const feat = (o: Partial<LiveEngineFeatureVM>): LiveEngineFeatureVM => ({
  detectorId: "campaign_below_breakeven", actionKind: "pause_campaign", name: "Pause campaign",
  watching: "Campaign is losing money", enabled: true, moneyCents: 0, actions: 0,
  lastAt: null, lastText: "no actions yet", approvals: 3, approvalsNeeded: 3,
  outcomes: 3, outcomesNeeded: 3, proven: true, ...o,
});
const prop = (o: Partial<QueueProposalVM>): QueueProposalVM => ({
  alertId: "a1", detector_id: "sku_stockout_vs_spend", action_kind: "pause_campaign",
  title: "Sold-out product still running ads", dollar_impact: 12000, confidence: 70,
  reasoning: "Out of stock", ...o,
});

describe("domainForDetector", () => {
  it("maps each domain", () => {
    expect(domainForDetector("campaign_below_breakeven")).toBe("ads");
    expect(domainForDetector("sku_stockout_vs_spend")).toBe("inv");
    expect(domainForDetector("margin_erosion")).toBe("price");
    expect(domainForDetector("return_rate_hidden_loss")).toBe("ret");
    expect(domainForDetector("unknown_xyz")).toBe("ads"); // safe default
  });
});

describe("buildFeatureGroups", () => {
  it("returns groups in fixed order and counts enabled vs total", () => {
    const groups = buildFeatureGroups([feat({ enabled: true })], [prop({})]);
    expect(groups.map((g) => g.key)).toEqual(["ads", "inv", "price", "ret"]);
    expect(countEnabled(groups)).toBe(1);          // the graduated, enabled feature
    expect(countTotal(groups)).toBeGreaterThanOrEqual(2); // graduated + locked pending
  });
  it("marks pending-only rows as locked", () => {
    const groups = buildFeatureGroups([], [prop({ detector_id: "sku_stockout_vs_spend" })]);
    const inv = groups.find((g) => g.key === "inv")!;
    expect(inv.rows.some((r) => r.locked)).toBe(true);
    expect(inv.onCount).toBe(0);
  });
  it("dedupes a (detector,action) present in both graduated and pending", () => {
    const groups = buildFeatureGroups(
      [feat({ detectorId: "sku_stockout_vs_spend", actionKind: "pause_campaign" })],
      [prop({ detector_id: "sku_stockout_vs_spend", action_kind: "pause_campaign" })],
    );
    const inv = groups.find((g) => g.key === "inv")!;
    expect(inv.rows.filter((r) => r.detectorId === "sku_stockout_vs_spend" && r.actionKind === "pause_campaign")).toHaveLength(1);
  });
});

describe("flaggedGroups", () => {
  it("flags the domain of each pending item", () => {
    const set = flaggedGroups([prop({ detector_id: "margin_erosion" }), prop({ detector_id: "sku_stockout_vs_spend" })]);
    expect(set.has("price")).toBe(true);
    expect(set.has("inv")).toBe(true);
    expect(set.has("ads")).toBe(false);
  });
});
```

- [ ] **Step 4: Run.** `npx vitest run app/components/dashboard/overview/__tests__/features-model.test.ts`. Fix `buildFeatureGroups`/`flaggedGroups` to use `domainForDetector` until all pass.

- [ ] **Step 5: Typecheck + commit.** `npm run typecheck` → 0.
```bash
git add app/components/dashboard/overview/features-model.ts app/components/dashboard/overview/__tests__/features-model.test.ts
git commit -m "feat(live-engine): feature-group model + detector→domain mapping"
```

---

## Task 4: Inspector view-model (pure, tested) — unifies history + pending

**Files:**
- Create: `app/components/dashboard/overview/inspector-vm.ts`
- Test: `app/components/dashboard/overview/__tests__/inspector-vm.test.ts`

**Interfaces — Consumes:** `TraceEventVM`, `PipelineCallVM`, `PipelineFactorVM` (live-engine-types), `QueueProposalVM` (view-models), `AlertVM` (view-models — for `evidence`/`narrative`). **Produces:**
```ts
export interface InspectorVM {
  tag: string;            // "NEEDS YOU" | trace tag
  time: string;           // clock or "now"
  title: string;
  signal: string;                 // WHAT IT SAW
  evidence: string[];             // chips
  factors: PipelineFactorVM[];    // HOW IT WEIGHED THIS
  confidence: number | null;      // 0-100
  threshold: number;              // 0-100 auto-act bar
  decisionLabel: string;          // DECISION pill
  decisionNote: string;
}
export function inspectorFromTrace(t: TraceEventVM): InspectorVM;
export function inspectorFromPending(p: QueueProposalVM, alert: AlertVM | undefined, call: PipelineCallVM | undefined): InspectorVM;
```

- [ ] **Step 1: Write the failing test.**
```ts
// app/components/dashboard/overview/__tests__/inspector-vm.test.ts
import { describe, it, expect } from "vitest";
import { inspectorFromTrace, inspectorFromPending } from "../inspector-vm";

const factors = [{ key: "hist", label: "Track record", value: 80, weight: 0.5 }];

describe("inspectorFromTrace", () => {
  it("passes through trace inspector fields", () => {
    const vm = inspectorFromTrace({
      id: "1", tag: "AUTO", detectorId: "campaign_below_breakeven", actionKind: "pause_campaign",
      text: "Paused X", moneyCents: 42000, time: "09:12", rel: "12 min ago",
      title: "Paused X", signal: "ROAS below break-even 6 days", evidence: ["ROAS 0.8", "Spend $300"],
      factors, confidence: 82, threshold: 75, decisionLabel: "DONE AUTOMATICALLY", decisionNote: "Above the bar.",
    });
    expect(vm.signal).toBe("ROAS below break-even 6 days");
    expect(vm.evidence).toEqual(["ROAS 0.8", "Spend $300"]);
    expect(vm.decisionLabel).toBe("DONE AUTOMATICALLY");
    expect(vm.confidence).toBe(82);
  });
});

describe("inspectorFromPending", () => {
  it("builds an inspector from proposal + alert evidence + pipeline factors", () => {
    const vm = inspectorFromPending(
      { alertId: "a1", detector_id: "sku_stockout_vs_spend", action_kind: "pause_campaign",
        title: "Sold-out product still running ads", dollar_impact: 12000, confidence: 70, reasoning: "Out of stock, still spending" },
      { id: "a1", evidence: ["0 units in stock", "$120/day spend"], narrative: "Out of stock, still spending" } as any,
      { detectorId: "sku_stockout_vs_spend", actionKind: "pause_campaign", title: "Pause", context: "Out of stock",
        factors, confidence: 70, threshold: 75, auto: false },
    );
    expect(vm.tag).toBe("NEEDS YOU");
    expect(vm.signal).toBe("Out of stock, still spending");
    expect(vm.evidence).toEqual(["0 units in stock", "$120/day spend"]);
    expect(vm.factors).toEqual(factors);
    expect(vm.confidence).toBe(70);
    expect(vm.threshold).toBe(75);
    expect(vm.decisionLabel).toBe("NEEDS YOUR APPROVAL");
  });
  it("degrades gracefully when alert/pipeline are missing", () => {
    const vm = inspectorFromPending(
      { alertId: "a2", detector_id: "margin_erosion", action_kind: "adjust_price",
        title: "Margin shrinking", dollar_impact: 5000, confidence: 55, reasoning: "Margin down" },
      undefined, undefined,
    );
    expect(vm.signal).toBe("Margin down");
    expect(vm.evidence).toEqual([]);
    expect(vm.factors).toEqual([]);
    expect(vm.confidence).toBe(55);
    expect(vm.threshold).toBe(75); // default bar when no pipeline call
  });
});
```

- [ ] **Step 2: Run to confirm fail.** `npx vitest run app/components/dashboard/overview/__tests__/inspector-vm.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement.**
```ts
// app/components/dashboard/overview/inspector-vm.ts
import type { TraceEventVM, PipelineCallVM, PipelineFactorVM } from "~/lib/calibration/live-engine-types";
import type { QueueProposalVM, AlertVM } from "~/components/dashboard/view-models";

export interface InspectorVM {
  tag: string; time: string; title: string;
  signal: string; evidence: string[];
  factors: PipelineFactorVM[]; confidence: number | null; threshold: number;
  decisionLabel: string; decisionNote: string;
}

export function inspectorFromTrace(t: TraceEventVM): InspectorVM {
  return {
    tag: t.tag, time: t.time, title: t.title,
    signal: t.signal, evidence: t.evidence ?? [],
    factors: t.factors ?? [], confidence: t.confidence, threshold: t.threshold,
    decisionLabel: t.decisionLabel, decisionNote: t.decisionNote,
  };
}

export function inspectorFromPending(
  p: QueueProposalVM, alert: AlertVM | undefined, call: PipelineCallVM | undefined,
): InspectorVM {
  const evidence = (alert?.evidence as string[] | undefined) ?? [];
  return {
    tag: "NEEDS YOU", time: "now", title: p.title,
    signal: alert?.narrative ?? p.reasoning,
    evidence,
    factors: call?.factors ?? [],
    confidence: call?.confidence ?? p.confidence,
    threshold: call?.threshold ?? 75,
    decisionLabel: "NEEDS YOUR APPROVAL",
    decisionNote: "Calderyn is confident enough to suggest this, not yet to do it on its own.",
  };
}
```
> NOTE: if `AlertVM` in `view-models.ts` has no `evidence: string[]` / `narrative: string` field, add the narrowest field the dashboard alert loader already returns (verify `dashboard.api.alerts` payload first). Prefer reusing an existing field over adding one.

- [ ] **Step 4: Run.** `npx vitest run app/components/dashboard/overview/__tests__/inspector-vm.test.ts` → PASS. `npm run typecheck` → 0.

- [ ] **Step 5: Commit.**
```bash
git add app/components/dashboard/overview/inspector-vm.ts app/components/dashboard/overview/__tests__/inspector-vm.test.ts
git commit -m "feat(live-engine): unified inspector view-model (history + pending)"
```

---

## Task 5: Restore the hero component (static structure, current design)

**Files:**
- Create: `app/components/dashboard/hero/AutopilotHero.tsx` (restore from `794978c`)
- Modify: `app/styles/dashboard.css` (append `.ha-*` hero styles)

**Interfaces — Consumes:** `WatchGroup` (Task 1), `HeroEngine` (Task 6 — import type; component renders structure now, wires motion in Task 6). **Produces:**
```ts
export interface AutopilotHeroProps {
  running: boolean; featureOn: number; featureTotal: number;
  calibrationPct: number | null; level: number; levels: number;
  moneyProtectedCents: number; flaggedGroups: Set<WatchGroup>; dark?: boolean;
}
export default function AutopilotHero(props: AutopilotHeroProps): JSX.Element;
```

- [ ] **Step 1: Pull design references.** DesignSync `get_file` `design_handoff_live_engine/AutopilotHero.dc.html`. Extract the hero's HTML structure, the `.ha-*` CSS (tokens in spec §"Design tokens"/handoff), and the hex-logo inline SVG. Also `live-engine-kit/CalibrationRing.dc.html`, `LiveBadge.dc.html` for the ring + badge.

- [ ] **Step 2: Restore the component.** `git show 794978c:app/components/dashboard/hero/AutopilotHero.tsx > app/components/dashboard/hero/AutopilotHero.tsx`. It already declares `AutopilotHeroProps` and mounts a `HeroEngine`. Comment out / guard the `HeroEngine` usage if Task 6 isn't done yet so it builds (e.g. lazy-init inside `useGSAP`).

- [ ] **Step 3: Re-derive the markup + styles to the current design** (pixel-perfect): hero card `border-radius:20px`, padding `24px 26px`, `--ha-bg` gradient + `--ha-shadow`; header row (hex feature-meter left + crossfading title + "N features active"; right: calibration ring "Level X of 5" + "$ protected this week"); three-column body (Watching list of Inventory/Ads/Pricing/Retention pills, middle scanning area, Acting card with state badge `STANDING BY`); reasoning chevron. Use the system font stack and the `--ha-*` tokens. Port `.ha-*` CSS into `app/styles/dashboard.css`. NO sonar/pulse circles.

- [ ] **Step 4: Build.** `npm run build` → 0. `/run` and confirm the static hero renders correctly in light + dark (no motion yet) with real props from a temporary mount or the Overview shell.

- [ ] **Step 5: Commit.**
```bash
git add app/components/dashboard/hero/AutopilotHero.tsx app/styles/dashboard.css
git commit -m "feat(live-engine): restore Autopilot hero structure + styles"
```

---

## Task 6: Hero motion engine (GSAP) + approve handoff

**Files:**
- Create: `app/components/dashboard/hero/hero-motion.ts` (restore from `794978c`, refine timings)
- Modify: `app/components/dashboard/hero/AutopilotHero.tsx` (wire `HeroEngine` via `useGSAP`)

**Interfaces — Consumes:** `WatchGroup`, `LeDockDetail` (Task 1). **Produces:** `HeroEngine` class (methods per recon: `updateMeter`, `updateCalibration`, `bumpCalibration`, `setTitle`, `toggleReason`/`openReason`/`setReasonInitial`/`isReasonOpen`, `startWatch`/`stopWatch`/`setFlags`, `dock`, `destroy`), plus `export function groupForActionKind(actionKind: string): WatchGroup` and `export function foldAndDock(row, {group,label}, onDock): void`.

**SUB-SKILLS:** invoke `gsap-react` (useGSAP + gsap.context cleanup), `gsap-core`, `gsap-timeline`, `gsap-plugins` (CustomEase), `gsap-utils`, `gsap-performance` before/while writing this task. This is presentational/motion code — verified by **build + run + visual**, not unit tests.

- [ ] **Step 1: Restore.** `git show 794978c:app/components/dashboard/hero/hero-motion.ts > app/components/dashboard/hero/hero-motion.ts`. Read the full file; it already implements the dock sequence, chip flight, intake outline, and act-execute.

- [ ] **Step 2: Pull the prototype motion.** From `design_handoff_live_engine/AutopilotHero.dc.html` (and `Calderyn Webapp.dc.html` for `approveReview`/`foldAndDock`/`groupForReview`), read the GSAP code: `dockApproved`, `runDockSequence`, `chipFlyToAct`, `receiveHandoff`, `actExecute`, the CustomEase defs, and the exact durations. Reconcile the restored file's timings with the prototype's (the prototype = intended production timings).

- [ ] **Step 3: Enforce the fidelity rules in the code:**
  - Register `CustomEase` `m3emph` / `m3std`; eases `power2.inOut`, `back.out(2.2–2.6)`, `elastic.out(1,0.55)`, `sine.out`.
  - Handoff timings exactly per spec §7 (fold 0.55s; chip arc lifted-quadratic-bezier control +84px, ~1.1–1.2s; dock Queued ~1.45s → Running 1.9s sweep → Done; Acting RECEIVING→RUNNING ~11.5s→DONE→STANDBY ~2.8s).
  - Steps 3 & 5 share the SAME chip-arc fn.
  - `makeIntakeOutline` positions a **fixed** overlay at the card's real `getBoundingClientRect()` (+~2px), reparented to `document.body`, NOT an `inset:-2px` child.
  - Wrap all timelines in `gsap.matchMedia()`; under `(prefers-reduced-motion: reduce)` jump to end states instantly.
  - Guard `toggleReason` re-entrancy (ignore while a toggle tween is active).
  - No radar/pulse/sonar — the `impact()` ripple is a single expanding **ring outline that fades once**, not a repeating sonar.

- [ ] **Step 4: Wire into the component.** In `AutopilotHero.tsx`, use `useGSAP(() => { const eng = new HeroEngine(root, {speed:1}); ...; return () => eng.destroy(); }, { scope: rootRef })`. Subscribe via `onEngine("le-dock", d => eng.dock(d))`, `onEngine("le-openreason", () => eng.openReason())`, `onEngine("le-calibrate", d => eng.bumpCalibration(d.kind, noteFor(d)))`. Drive `updateMeter(featureOn, featureTotal)`, `updateCalibration(pct, ...)`, `setTitle(running)`, `setFlags(flaggedGroups)` from props via `useGSAP` deps.

- [ ] **Step 5: Verify.** `npm run typecheck` → 0; `npm run build` → 0. `/run`: open Overview, toggle reasoning (no half-open on rapid clicks), and approve a pending Log row → watch fold → chip arc → group Queued/Running/Done → chip arc → Acting RECEIVING→RUNNING→DONE; outline hugs the real card edge; ring bumps. Re-run with OS reduced-motion ON → instant states, no flights. Confirm 60fps-ish (no jank) per gsap-performance.

- [ ] **Step 6: Commit.**
```bash
git add app/components/dashboard/hero/hero-motion.ts app/components/dashboard/hero/AutopilotHero.tsx
git commit -m "feat(live-engine): GSAP hero motion + approve handoff choreography"
```

---

## Task 7: Calderyn Log (real approve/deny) + Autopilot features + Inspector

**Files:**
- Create: `app/components/dashboard/overview/CalderynLog.tsx`, `AutopilotFeatures.tsx`, `InspectorPanel.tsx` (restore from `794978c`, adapt)

**Interfaces — Consumes:** `TraceEventVM`, `QueueProposalVM`, `FeatureGroupVM` (Task 3), `InspectorVM` + builders (Task 4), `emitEngine`/`foldAndDock` (Tasks 1/6), the dashboard client (`executeAlertAction`, `rejectProposal`, `toggleFeatureAutonomy`) + `DashboardCtx`. **Produces:** the three default-exported components used by Task 8.

- [ ] **Step 1: Restore all three.**
```bash
git show 794978c:app/components/dashboard/overview/CalderynLog.tsx > app/components/dashboard/overview/CalderynLog.tsx
git show 794978c:app/components/dashboard/overview/AutopilotFeatures.tsx > app/components/dashboard/overview/AutopilotFeatures.tsx
git show 794978c:app/components/dashboard/overview/InspectorPanel.tsx > app/components/dashboard/overview/InspectorPanel.tsx
```

- [ ] **Step 2: Wire CalderynLog approve to the REAL endpoint.** In `PendingRow` approve handler: call `executeAlertAction(proposal.alertId, { type: proposal.action_kind })` (client.ts). On success: `emitEngine("le-calibrate", { kind: "approve", delta: receipt.calibration?.delta })`, `emitEngine("le-openreason")`, then `foldAndDock(rowEl, { group: domainForDetector(proposal.detector_id), label: proposal.title }, () => emitEngine("le-dock", { group, label, money: money(receipt impact) }))`. After ~1800ms call `app.refreshLiveEngine()` + `app.refreshCalibration?.()`. Handle the receipt's `justGraduated` (toast/celebration) if present.

- [ ] **Step 3: Wire deny.** Inline reason chips (`too_aggressive | wrong_timing | not_enough_data | i_handle_this | other`) → `rejectProposal({ alertId, reason, note? })`; mark row DISMISSED; `emitEngine("le-calibrate", { kind: "deny", delta: result.delta })`; show `result.reflection`. Refresh queue.

- [ ] **Step 4: Wire toggles + Inspector.** `AutopilotFeatures` toggle → `toggleFeatureAutonomy({detectorId, actionKind, enabled})` then `app.refreshLiveEngine()` (updates the hero hex via Task 8's prop flow); locked rows show a lock + `title="Approve more to unlock"`; "N on" badge. `InspectorPanel` consumes an `InspectorVM` (build with `inspectorFromTrace` for history rows, `inspectorFromPending` for flagged rows using `app.alerts.find(a=>a.id===alertId)` + matching `pipeline[]` call). Sections: WHAT IT SAW / HOW IT WEIGHED THIS (factor bars + confidence vs threshold) / DECISION.

- [ ] **Step 5: Re-derive visuals** from `live-engine-kit/TraceRow.dc.html`, `FeatureToggleRow.dc.html`, `InspectorPanel.dc.html`, `FactorBars.dc.html`, `ConfidenceGauge.dc.html`, `ReasoningStream.dc.html`. Internal scroll (log + features `max-height:360px`).

- [ ] **Step 6: Verify.** `npm run typecheck` → 0; `npm run build` → 0. `/run`: approve hits the real action (audit row appears after refresh), deny records a real rejection + shows reflection, toggle flips autonomy + hero meter, clicking a flagged row opens the Inspector with real evidence/factors. Commit:
```bash
git add app/components/dashboard/overview/CalderynLog.tsx app/components/dashboard/overview/AutopilotFeatures.tsx app/components/dashboard/overview/InspectorPanel.tsx
git commit -m "feat(live-engine): Calderyn Log + features + inspector wired to real engine"
```

---

## Task 8: Overview screen = Live Engine; move content to Analytics

**Files:**
- Modify: `app/components/dashboard/screens/Dashboard.tsx` (becomes Live Engine Overview)
- Modify: `app/components/dashboard/screens/Analytics.tsx` (absorb moved cards)
- Modify: `app/components/dashboard/DashboardApp.tsx` (ensure `liveEngine`+`actionQueue` loaded for Overview; rail-swap state)

**Interfaces — Consumes:** Tasks 3–7 components + `LiveEnginePageData`/`actionQueue` from `DashboardCtx`.

- [ ] **Step 1: Rebuild `Dashboard.tsx`** to render: header ("Good morning" + subtitle + All-alerts), `AutopilotHero` (props derived via `buildFeatureGroups`/`countEnabled`/`countTotal`/`flaggedGroups`; `running = !!data && data.autopilotEnabled && featureOn>0`), then a two-column row: left `CalderynLog` (`trace=data.trace`, `pending=app.actionQueue`), right rail `AutopilotFeatures` that swaps to `InspectorPanel` when a row is selected (rail-swap state in this screen or `DashboardApp`). Remove react-grid-layout machinery and the old cards. Set `--type-scale:1.1` on the Overview root.

- [ ] **Step 2: Move the old Overview cards into `Analytics.tsx`.** Bring StatRow, FocusCard, ActivityFeed, RevenueCard, AttentionSection, PredictorCard, GuardrailCard, PeerBenchmarks. **Dedupe**: Analytics already has a revenue-vs-spend chart and KPI row — keep Analytics's versions, drop the Overview duplicates; fold FocusCard/Attention/Guardrail/Predictor/Benchmarks/ActivityFeed in under the existing Analytics sections. Ensure Analytics still fetches what those cards need (`fetchOverview`, `fetchGuardrails`, `fetchBenchmarks`) — wire any missing fetch in `DashboardApp` load().

- [ ] **Step 3: Ensure data availability.** In `DashboardApp.tsx`, confirm `liveEngine` + `actionQueue` are fetched on mount and kept fresh by the existing 45s `useLiveFeed`; the Overview no longer needs the overview/guardrail/benchmark fetches (those move with the cards to Analytics).

- [ ] **Step 4: Verify.** `npm run typecheck` → 0; `npm run build` → 0; `vitest run` → 0. `/run`: Overview shows ONLY the Live Engine; Analytics shows the moved cards with no duplicates; nav + polling intact; light/dark OK.

- [ ] **Step 5: Commit.**
```bash
git add app/components/dashboard/screens/Dashboard.tsx app/components/dashboard/screens/Analytics.tsx app/components/dashboard/DashboardApp.tsx
git commit -m "feat(dashboard): Overview = Live Engine; move legacy cards to Analytics"
```

---

## Task 9: Embedded mirror (Polaris home = Live Engine; new analytics; engine redirect)

**Files:**
- Create: `app/components/calderyn/LiveEngineHero.tsx`, `app/components/calderyn/CalderynLog.tsx`, `app/routes/app.analytics.tsx`
- Modify: `app/routes/app._index.tsx`, `app/routes/app.engine.tsx`

**Interfaces — Consumes:** `buildLiveEnginePageData` (already used by `app.engine.tsx` loader), existing embedded endpoints (approve `POST /app/alerts/$id`, reject `POST /app/queue intent`, toggle `POST /app/engine intent=toggle-feature`), `@shopify/polaris-icons`, `app/components/calderyn/*`.

- [ ] **Step 1: Build the Polaris hero + log** (`LiveEngineHero.tsx`, `CalderynLog.tsx`). Same information design as the webapp, Polaris primitives (`Card`, `BlockStack`, `InlineStack`, `Badge`, `Button`, `ProgressBar`), `@shopify/polaris-icons`. **Lighter motion**: GSAP allowed but minimal (calibration ring tween + count-ups + a short single chip move on approve, all behind `gsap.matchMedia`); skip the elaborate dual chip-arc if it janks in the iframe — a simple "fold + confirm + refresh" is acceptable on embedded. Reuse `CountUp` from `app/components/calderyn`.

- [ ] **Step 2: Make `app/routes/app._index.tsx` the Live Engine home.** Loader: `buildLiveEnginePageData(client, signal)` + `client.queue.list()` for pending + calibration. Render `LiveEngineHero` + `CalderynLog`. Approve posts to `/app/alerts/$id` (existing), reject to `/app/queue` (existing), toggle to `/app/engine` (existing). Keep the autopilot-on-load run if it was there.

- [ ] **Step 3: Create `app/routes/app.analytics.tsx`** holding the embedded home's prior content (focus, stat tiles, queue snapshot, recent actions, benchmarks) — move that JSX out of the old `_index` into this route. Add an "Analytics" nav link in the embedded app nav.

- [ ] **Step 4: Redirect `app/routes/app.engine.tsx`.** Replace its loader body with `return redirect("/app");` (keep the file so deep links don't 404). Remove its now-duplicated UI.

- [ ] **Step 5: Verify.** `npm run typecheck` → 0; `npm run lint` → 0; `npm run build` → 0. `/run` the embedded app (Shopify admin): home shows the Live Engine, approve/deny/toggle hit the real endpoints, `/app/engine` redirects to `/app`, `/app/analytics` shows the moved content. Polaris-icons only (no Lucide on `app.*`).

- [ ] **Step 6: Commit.**
```bash
git add app/components/calderyn/LiveEngineHero.tsx app/components/calderyn/CalderynLog.tsx app/routes/app._index.tsx app/routes/app.analytics.tsx app/routes/app.engine.tsx
git commit -m "feat(embedded): mirror Live Engine onto app home; move content to /app/analytics"
```

---

## Task 10: Full gate + cross-surface QA + parity

**Files:** none (verification) — fix-ups land in the relevant task's files.

- [ ] **Step 1: `/code-review`** the working tree (whole branch). Resolve every blocker; downgrade nits with a one-line justification.
- [ ] **Step 2: Patch sanity.** `git diff main...HEAD --stat`; `git diff --check`; grep the diff for stray `console.log`, `.only`, `TODO(me)`, commented-out blocks, AI/prototype/design-tool provenance, `support.js`, `.dc.html`, `sourceMappingURL`.
- [ ] **Step 3: Eval pipeline (in order, paste output):** `npm run typecheck` → 0; `npm run lint` → 0 (`--max-warnings=0` on touched files); `vitest run` → 0; `npm run build` → 0 (verifier green). No prisma/codegen steps unless a schema/`.graphql` actually changed (none expected).
- [ ] **Step 4: End-to-end visual QA** on the showcase store (`calderyn-review-store`, demo_mode) for BOTH surfaces: approve handoff full sequence; deny + reflection; feature toggle ↔ hero meter; inspector for history + flagged; light/dark; reduced-motion; empty states (no pending / no trace). Capture before/after screenshots.
- [ ] **Step 5: Parity check.** Confirm the embedded mirror matches the webapp's behavior/data contract (not its Polaris-vs-cd code). Note any intentional embedded simplification in the PR description.
- [ ] **Step 6: Final summary commit** (if any fix-ups) and stop for review handoff. Do NOT push or open a PR without explicit request.

---

## Self-Review

**Spec coverage:** Overview→Live Engine (Tasks 5–8) ✓; move to Analytics (Task 8) ✓; real-data wiring incl. approve/deny/toggle + ring-by-real-delta + CustomEvent seam (Tasks 1,4,6,7) ✓; Inspector reasoning incl. pending items (Tasks 4,7) ✓; global re-theme (Task 2) ✓; embedded mirror + new analytics + engine redirect (Task 9) ✓; GSAP via skills + fidelity rules + reduced-motion (Task 6) ✓; deps flagged (Task 1) ✓; no env/version changes (Global Constraints) ✓; both surfaces (Tasks 8,9) ✓; gate + parity (Task 10) ✓. Spec §6.5 (pending inspector enrichment) resolved client-side via `inspectorFromPending` (Task 4) — no schema change.

**Placeholder scan:** Pure-logic tasks (1,3,4) carry full test + impl code. Visual/motion tasks (2,5,6,7,9) specify exact restore commands, the precise design files to pull, exact tokens/timings (spec §7), and concrete visual verification — the "code" being ported lives in the named source files, which is the correct ground truth for a pixel port (not a placeholder).

**Type consistency:** `WatchGroup` (Task 1) used identically in Tasks 3/6/7. `FeatureRowVM`/`FeatureGroupVM`/`buildFeatureGroups`/`flaggedGroups`/`domainForDetector` (Task 3) consumed by Tasks 7/8 with matching signatures. `InspectorVM`/`inspectorFromTrace`/`inspectorFromPending` (Task 4) consumed by Task 7. `AutopilotHeroProps` (Task 5) matches what Task 8 passes. `HeroEngine` methods (Task 6) match the `onEngine` wiring in Tasks 6/7. Endpoint client methods (`executeAlertAction`/`rejectProposal`/`toggleFeatureAutonomy`) match the recon'd `client.ts` signatures.
