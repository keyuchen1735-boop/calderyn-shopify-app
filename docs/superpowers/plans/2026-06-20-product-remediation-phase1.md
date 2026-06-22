# Product-Economics Remediation — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Snooze-only" Fix-it panel on product-economics alerts with a plain-language synopsis plus a ranked list of strategic moves (discontinue / cut ads / reallocate to a winner / fix returns / review pricing), computed by a deterministic, fully-tested engine.

**Architecture:** A pure ranking engine (`app/lib/remediation/`) reads the per-unit economics that detectors *already* put on `alert.evidence`, decides the best strategic move by fixed rules, and produces a `RemediationPlan` + a templated synopsis. The plan is attached server-side in `rowToAlert()` (the single converter both the dashboard and the embedded app flow through), so both surfaces render the same decision with no forked logic. Phase 1 ships **advisory** moves only (the strategic moves are shown as guidance; the sole executable action remains the existing Snooze). The same pure engine is reused by the executors and autopilot in Phases 2–4.

**Tech Stack:** TypeScript (strict, ESM), Vitest, Remix loaders, Supabase (read-only here), React + bespoke `cd-*` CSS (dashboard) / Shopify Polaris (embedded app).

---

## Scope & deliberate simplifications (read first)

Phase 1 is the first vertical slice of the 4-phase spec (`docs/superpowers/specs/2026-06-20-product-economics-remediation-design.md`). Deliberate trims vs the spec, all deferred to later phases (rule 12 — stated, not hidden):

- **No DB column / no migration.** The plan is computed on read from evidence (cheap, deterministic, zero extra queries). The `remediation jsonb` column + caching land in Phase 4 when AI prose makes recompute expensive.
- **No AI prose.** Synopsis is a per-detector deterministic template (the spec's fallback path). AI enrichment defers to a later phase.
- **No named "winner."** `reallocate_to_winner` is advisory and generic ("move spend to a higher-margin product"). Naming the specific winner needs the margin-ranking view and lands in Phase 3 with the Meta budget-shift executor that consumes it.
- **Advisory only.** The strategic moves are not yet executable buttons (Shopify archive = Phase 2, Meta budget shift = Phase 3). Phase 1 renders them as ranked guidance; **Snooze stays the one working button.**

Detectors in scope (all 5 product-economics): `negative_unit_economics`, `ad_tax_overload`, `return_rate_hidden_loss`, `margin_erosion`, `cogs_drift`. All other detectors keep their existing `adaptAlert` behavior untouched.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `app/lib/remediation/types.ts` | `MoveKind`, `StrategicMove`, `RemediationInput`, `RemediationPlan` | 1 |
| `app/lib/remediation/rank.ts` | Pure `rankMoves(input) → RemediationPlan` + numeric-evidence helper | 2, 3 |
| `app/lib/remediation/synopsis.ts` | Pure `synopsisFor(plan, input) → string` (templated) | 4 |
| `app/lib/remediation/__tests__/rank.test.ts` | Engine tests | 2, 3 |
| `app/lib/remediation/__tests__/synopsis.test.ts` | Synopsis tests | 4 |
| `app/lib/calderyn.server.ts` | Attach `remediation` + `rec_detail` in `rowToAlert()` | 5 |
| `app/lib/types.ts` | Add `remediation` + `rec_detail` to `Alert` | 5 |
| `app/components/dashboard/view-models.ts` | Add `remediation` to `AlertVM` | 6 |
| `app/lib/dashboard/client.ts` | `adaptAlert` passes through; uses plan moves when present | 6 |
| `app/lib/dashboard/__tests__/adapt-alert.test.ts` | adaptAlert passthrough test | 6 |
| `app/lib/labels.ts` + `app/components/dashboard/format.ts` + `icons.tsx` | Labels/icons for new move kinds | 7 |
| `app/components/dashboard/screens/Alerts.tsx` | Dashboard Fix-it panel render | 8 |
| `app/routes/app.alerts.$id.tsx` | Embedded Fix-it panel render | 9 |

---

## Task 1: Remediation types

**Files:**
- Create: `app/lib/remediation/types.ts`

- [ ] **Step 1: Write the types file**

```typescript
// app/lib/remediation/types.ts
// Pure types for the product-economics remediation engine. No imports from
// server modules — this file (and rank.ts / synopsis.ts) must stay importable
// from both client and server, and from future autopilot code.

import type { DetectorId } from "../types";

/** Strategic moves the engine can recommend. Phase 1 surfaces all of these as
 *  advisory guidance; only `snooze` is executable today (the others gain
 *  executors in Phases 2–3). */
export type MoveKind =
  | "discontinue" // stop reordering / archive the product
  | "cut_ads" // pause or cut the ad spend driving the loss
  | "reallocate_to_winner" // move ad budget to a higher-margin product
  | "fix_returns" // address the return driver before scaling
  | "review_pricing" // raise price / renegotiate COGS
  | "snooze"; // defer the alert

export interface StrategicMove {
  kind: MoveKind;
  /** Projected 30-day dollars recovered/gained, in cents. Drives the ranking. */
  dollarImpactCents: number;
  /** Phase 1: only "snooze" maps to a live executor ("snooze_alert"); the rest
   *  are advisory (null) until their executors ship. */
  executor: "snooze_alert" | null;
  /** Short human label for the move (UI). */
  label: string;
}

export interface RemediationInput {
  detectorId: DetectorId;
  /** alert.dollar_impact — already in cents at the DTO boundary. */
  dollarImpactCents: number;
  /** Evidence coerced to numbers (USD dollars), nulls for missing keys. */
  evidence: Record<string, number | null>;
}

export interface RemediationPlan {
  /** Ranked desc by dollarImpactCents, deterministic tie-break. snooze is last. */
  moves: StrategicMove[];
  /** The top non-snooze move, or null when only snooze applies. */
  recommended: MoveKind | null;
  /** net contribution/unit at zero ad spend ≤ 0 → the product can't be fixed by
   *  tuning ads; discontinue is the only real lever. */
  structurallyDead: boolean;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0 (no references to undefined symbols; `DetectorId` resolves from `../types`).

- [ ] **Step 3: Commit**

```bash
git add app/lib/remediation/types.ts
git commit -m "remediation/types: strategic move + plan types"
```

---

## Task 2: `rankMoves` core — the ditch-vs-tune gate

This is the crux. Structurally-dead products (gross margin ≤ 0) get **discontinue**; viable but ad-bled products get **reallocate/cut_ads**.

**Files:**
- Create: `app/lib/remediation/rank.ts`
- Test: `app/lib/remediation/__tests__/rank.test.ts`

- [ ] **Step 1: Write failing tests for the gate**

```typescript
// app/lib/remediation/__tests__/rank.test.ts
import { describe, it, expect } from "vitest";
import { rankMoves, toNumericEvidence } from "../rank";
import type { RemediationInput } from "../types";

function input(p: Partial<RemediationInput>): RemediationInput {
  return {
    detectorId: "negative_unit_economics",
    dollarImpactCents: 530449,
    evidence: {},
    ...p,
  };
}

describe("rankMoves — ditch vs tune gate", () => {
  it("viable product bled by ads → recommends reallocate, NOT discontinue (the screenshot case)", () => {
    // Summit Logo Tee — M: +$23 gross margin, $170 CAC, -$147 net.
    const plan = rankMoves(
      input({
        detectorId: "negative_unit_economics",
        evidence: { gross_unit_margin_usd: 23, cac_per_unit_usd: 170, net_per_unit_usd: -147 },
      }),
    );
    expect(plan.structurallyDead).toBe(false);
    expect(plan.recommended).toBe("reallocate_to_winner");
    expect(plan.moves.map((m) => m.kind)).toContain("cut_ads");
    expect(plan.moves.map((m) => m.kind)).not.toContain("discontinue");
  });

  it("structurally dead product (gross margin ≤ 0) → recommends discontinue, not ad moves", () => {
    const plan = rankMoves(
      input({
        detectorId: "negative_unit_economics",
        evidence: { gross_unit_margin_usd: -4, cac_per_unit_usd: 30, net_per_unit_usd: -34 },
      }),
    );
    expect(plan.structurallyDead).toBe(true);
    expect(plan.recommended).toBe("discontinue");
    expect(plan.moves.map((m) => m.kind)).not.toContain("cut_ads");
    expect(plan.moves.map((m) => m.kind)).not.toContain("reallocate_to_winner");
  });

  it("always appends snooze last, and snooze is the only executable move in Phase 1", () => {
    const plan = rankMoves(input({ evidence: { gross_unit_margin_usd: 23, cac_per_unit_usd: 170 } }));
    expect(plan.moves[plan.moves.length - 1].kind).toBe("snooze");
    const executable = plan.moves.filter((m) => m.executor !== null);
    expect(executable.map((m) => m.kind)).toEqual(["snooze"]);
  });

  it("toNumericEvidence coerces strings and drops non-numerics to null", () => {
    expect(toNumericEvidence({ a: "23", b: 170, c: "x", d: null })).toEqual({
      a: 23,
      b: 170,
      c: null,
      d: null,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/lib/remediation/__tests__/rank.test.ts`
Expected: FAIL — "Failed to resolve import ../rank" / `rankMoves is not a function`.

- [ ] **Step 3: Write the implementation**

```typescript
// app/lib/remediation/rank.ts
import type { DetectorId } from "../types";
import type { MoveKind, RemediationInput, RemediationPlan, StrategicMove } from "./types";

/** Coerce a raw evidence record (values may be strings, numbers, or null) into
 *  numbers. Non-numeric / missing values become null. Pure. */
export function toNumericEvidence(
  ev: Record<string, unknown>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(ev ?? {})) {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    out[k] = Number.isFinite(n) ? n : null;
  }
  return out;
}

const MOVE_LABELS: Record<MoveKind, string> = {
  discontinue: "Stop reordering this product",
  reallocate_to_winner: "Move ad budget to a higher-margin product",
  cut_ads: "Cut the ad spend driving the loss",
  fix_returns: "Fix the return driver before scaling",
  review_pricing: "Raise price or renegotiate cost",
  snooze: "Snooze",
};

// Deterministic tie-break when two moves have equal projected impact. Lower
// index wins. discontinue first (most decisive), snooze last.
const MOVE_PRIORITY: MoveKind[] = [
  "discontinue",
  "reallocate_to_winner",
  "fix_returns",
  "cut_ads",
  "review_pricing",
  "snooze",
];

const PRODUCT_ECON_DETECTORS: ReadonlySet<DetectorId> = new Set<DetectorId>([
  "negative_unit_economics",
  "ad_tax_overload",
  "return_rate_hidden_loss",
  "margin_erosion",
  "cogs_drift",
]);

/** Per-unit gross margin at ZERO ad spend (price − COGS − ship), per detector.
 *  Returns null when no per-unit margin is on the evidence. */
function grossUnitMarginUsd(d: DetectorId, ev: Record<string, number | null>): number | null {
  switch (d) {
    case "negative_unit_economics":
      return ev.gross_unit_margin_usd;
    case "return_rate_hidden_loss":
      return ev.unit_margin_usd;
    case "margin_erosion":
      return ev.current_unit_margin_usd ?? ev.unit_margin_usd;
    default:
      return null;
  }
}

/** Is the product unprofitable even before any ad spend? When we lack a per-unit
 *  margin, fall back to the 7-day gross profit sign (ad_tax_overload / cogs_drift
 *  carry gross_profit_7d_usd). Unknown → treat as not dead (advisory). */
function isStructurallyDead(d: DetectorId, ev: Record<string, number | null>): boolean {
  const m = grossUnitMarginUsd(d, ev);
  if (m != null) return m <= 0;
  if (ev.gross_profit_7d_usd != null) return ev.gross_profit_7d_usd <= 0;
  return false;
}

const AD_DRIVEN: ReadonlySet<DetectorId> = new Set<DetectorId>([
  "negative_unit_economics",
  "ad_tax_overload",
]);

function move(kind: MoveKind, dollarImpactCents: number): StrategicMove {
  return {
    kind,
    dollarImpactCents,
    executor: kind === "snooze" ? "snooze_alert" : null,
    label: MOVE_LABELS[kind],
  };
}

export function rankMoves(input: RemediationInput): RemediationPlan {
  const { detectorId: d, dollarImpactCents: impact, evidence: ev } = input;

  // Non-product-economics detectors get no plan (caller falls back to legacy
  // action logic). Defensive: the server only calls this for the 5 in scope.
  if (!PRODUCT_ECON_DETECTORS.has(d)) {
    return { moves: [move("snooze", 0)], recommended: null, structurallyDead: false };
  }

  const structurallyDead = isStructurallyDead(d, ev);
  const moves: StrategicMove[] = [];

  if (structurallyDead) {
    // Can't be fixed by tuning ads — stopping it saves the whole modeled loss.
    moves.push(move("discontinue", impact));
  } else {
    if (AD_DRIVEN.has(d)) {
      // Viable product, ads are the bleed: reallocate keeps the margin AND earns
      // on a winner; cut_ads is the simpler fallback. Equal $ recovered → the
      // tie-break makes reallocate the recommendation.
      moves.push(move("reallocate_to_winner", impact));
      moves.push(move("cut_ads", impact));
    }
    if (d === "return_rate_hidden_loss") {
      const ret = ev.return_30d_usd;
      moves.push(move("fix_returns", ret != null ? Math.round(ret * 100) : impact));
    }
    if ((d === "margin_erosion" || d === "cogs_drift") && moves.length === 0) {
      moves.push(move("review_pricing", impact));
    }
  }

  moves.push(move("snooze", 0));

  moves.sort(
    (a, b) =>
      b.dollarImpactCents - a.dollarImpactCents ||
      MOVE_PRIORITY.indexOf(a.kind) - MOVE_PRIORITY.indexOf(b.kind),
  );

  const recommended = moves.find((m) => m.kind !== "snooze")?.kind ?? null;
  return { moves, recommended, structurallyDead };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/lib/remediation/__tests__/rank.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/remediation/rank.ts app/lib/remediation/__tests__/rank.test.ts
git commit -m "remediation/rank: ditch-vs-tune gate + move ranking"
```

---

## Task 3: `rankMoves` — returns, margin erosion, COGS drift

**Files:**
- Modify: `app/lib/remediation/__tests__/rank.test.ts` (append)
- (no code change to `rank.ts` expected — Task 2 already implements these branches; this task proves them)

- [ ] **Step 1: Append verifying tests**

```typescript
// append to app/lib/remediation/__tests__/rank.test.ts
describe("rankMoves — returns, margin, cogs", () => {
  it("return_rate_hidden_loss → recommends fix_returns, scored by 30d return dollars", () => {
    const plan = rankMoves(
      input({
        detectorId: "return_rate_hidden_loss",
        dollarImpactCents: 100000,
        evidence: { unit_margin_usd: 12, return_rate: 0.31, return_30d_usd: 1800 },
      }),
    );
    expect(plan.recommended).toBe("fix_returns");
    const fix = plan.moves.find((m) => m.kind === "fix_returns")!;
    expect(fix.dollarImpactCents).toBe(180000); // 1800 USD → cents
  });

  it("ad_tax_overload with positive 7d gross profit → ad moves (reallocate recommended)", () => {
    const plan = rankMoves(
      input({
        detectorId: "ad_tax_overload",
        evidence: { gross_profit_7d_usd: 900, ad_tax_ratio: 0.62, ad_spend_7d_usd: 1400, revenue_7d_usd: 2200 },
      }),
    );
    expect(plan.structurallyDead).toBe(false);
    expect(plan.recommended).toBe("reallocate_to_winner");
  });

  it("ad_tax_overload with negative 7d gross profit → structurally dead → discontinue", () => {
    const plan = rankMoves(
      input({ detectorId: "ad_tax_overload", evidence: { gross_profit_7d_usd: -120 } }),
    );
    expect(plan.structurallyDead).toBe(true);
    expect(plan.recommended).toBe("discontinue");
  });

  it("margin_erosion still profitable → recommends review_pricing", () => {
    const plan = rankMoves(
      input({
        detectorId: "margin_erosion",
        evidence: { baseline_unit_margin_usd: 18, current_unit_margin_usd: 7, drop_pct: 61 },
      }),
    );
    expect(plan.recommended).toBe("review_pricing");
  });

  it("margin_erosion gone negative → discontinue overrides review_pricing", () => {
    const plan = rankMoves(
      input({ detectorId: "margin_erosion", evidence: { current_unit_margin_usd: -2 } }),
    );
    expect(plan.structurallyDead).toBe(true);
    expect(plan.recommended).toBe("discontinue");
  });

  it("cogs_drift still profitable → review_pricing", () => {
    const plan = rankMoves(
      input({
        detectorId: "cogs_drift",
        evidence: { prior_unit_cost_usd: 9, current_unit_cost_usd: 13, drift_pct: 44, gross_profit_7d_usd: 400 },
      }),
    );
    expect(plan.recommended).toBe("review_pricing");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run app/lib/remediation/__tests__/rank.test.ts`
Expected: PASS (all 10 tests). If any fail, fix `rank.ts` until green — do not edit the tests to pass.

- [ ] **Step 3: Commit**

```bash
git add app/lib/remediation/__tests__/rank.test.ts
git commit -m "remediation/rank: cover returns, margin erosion, cogs drift"
```

---

## Task 4: Deterministic synopsis templates

**Files:**
- Create: `app/lib/remediation/synopsis.ts`
- Test: `app/lib/remediation/__tests__/synopsis.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// app/lib/remediation/__tests__/synopsis.test.ts
import { describe, it, expect } from "vitest";
import { synopsisFor } from "../synopsis";
import { rankMoves } from "../rank";
import type { RemediationInput } from "../types";

function withSynopsis(p: RemediationInput) {
  return synopsisFor(rankMoves(p), p);
}

describe("synopsisFor", () => {
  it("viable-but-ad-bled product explains it's the ads, not the product", () => {
    const s = withSynopsis({
      detectorId: "negative_unit_economics",
      dollarImpactCents: 530449,
      evidence: { gross_unit_margin_usd: 23, cac_per_unit_usd: 170, net_per_unit_usd: -147 },
    });
    expect(s).toContain("$23");
    expect(s).toContain("$170");
    expect(s.toLowerCase()).toContain("ad");
    expect(s.toLowerCase()).not.toContain("stop reordering");
  });

  it("structurally dead product tells the merchant to stop reordering", () => {
    const s = withSynopsis({
      detectorId: "negative_unit_economics",
      dollarImpactCents: 50000,
      evidence: { gross_unit_margin_usd: -4, net_per_unit_usd: -34 },
    });
    expect(s.toLowerCase()).toContain("stop");
  });

  it("returns synopsis names the return rate and the recovered dollars", () => {
    const s = withSynopsis({
      detectorId: "return_rate_hidden_loss",
      dollarImpactCents: 100000,
      evidence: { unit_margin_usd: 12, return_rate: 0.31, return_30d_usd: 1800 },
    });
    expect(s).toContain("31%");
    expect(s).toContain("$1,800");
  });

  it("never returns an empty string for any in-scope detector", () => {
    for (const detectorId of [
      "negative_unit_economics",
      "ad_tax_overload",
      "return_rate_hidden_loss",
      "margin_erosion",
      "cogs_drift",
    ] as const) {
      const s = withSynopsis({ detectorId, dollarImpactCents: 10000, evidence: {} });
      expect(s.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/lib/remediation/__tests__/synopsis.test.ts`
Expected: FAIL — cannot resolve `../synopsis`.

- [ ] **Step 3: Write the implementation**

```typescript
// app/lib/remediation/synopsis.ts
import type { DetectorId } from "../types";
import type { RemediationInput, RemediationPlan } from "./types";

// Money/percent formatters local to the engine so this stays pure (no UI deps).
function usd(n: number | null | undefined): string {
  if (n == null) return "$0";
  const neg = n < 0;
  const s = "$" + Math.round(Math.abs(n)).toLocaleString("en-US");
  return neg ? "-" + s : s;
}
function pct(frac: number | null | undefined): string {
  if (frac == null) return "0%";
  // return_rate arrives as a 0..1 fraction; ratios too.
  return Math.round(frac * 100) + "%";
}

/** One or two plain sentences: what's wrong + the recommended move. Deterministic
 *  template per (detector, structurallyDead). Never empty (rule 12). */
export function synopsisFor(plan: RemediationPlan, input: RemediationInput): string {
  const ev = input.evidence;
  const d: DetectorId = input.detectorId;

  if (plan.structurallyDead) {
    return (
      `This product loses money on every sale even before ad spend — ` +
      `reordering it just funds the loss. Stop restocking it and clear what's left.`
    );
  }

  switch (d) {
    case "negative_unit_economics":
      return (
        `This product makes ${usd(ev.gross_unit_margin_usd)} a unit — it isn't the problem. ` +
        `You're paying ${usd(ev.cac_per_unit_usd)} in ads per sale, so each order nets ` +
        `${usd(ev.net_per_unit_usd)}. Cut or move that ad spend; the product is fine.`
      );
    case "ad_tax_overload":
      return (
        `Ads eat ${pct(ev.ad_tax_ratio)} of this product's revenue ` +
        `(${usd(ev.ad_spend_7d_usd)} spent against ${usd(ev.revenue_7d_usd)} in sales). ` +
        `Cut the spend or move it to a higher-ROAS product.`
      );
    case "return_rate_hidden_loss":
      return (
        `${pct(ev.return_rate)} of these come back, erasing ${usd(ev.return_30d_usd)} of margin ` +
        `that the top-line hides. Fix the return driver (sizing, photos, quality) before scaling — ` +
        `or pull ads on it until it's fixed.`
      );
    case "margin_erosion":
      return (
        `Margin slipped from ${usd(ev.baseline_unit_margin_usd)} to ` +
        `${usd(ev.current_unit_margin_usd)} a unit. Raise the price or renegotiate cost ` +
        `before it turns negative.`
      );
    case "cogs_drift":
      return (
        `Unit cost rose from ${usd(ev.prior_unit_cost_usd)} to ${usd(ev.current_unit_cost_usd)} ` +
        `(${pct((ev.drift_pct ?? 0) / 100)}), thinning every sale. Re-price or renegotiate COGS.`
      );
    default:
      return `Review this product's unit economics — it's losing margin.`;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/lib/remediation/__tests__/synopsis.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/remediation/synopsis.ts app/lib/remediation/__tests__/synopsis.test.ts
git commit -m "remediation/synopsis: deterministic per-detector templates"
```

---

## Task 5: Attach remediation server-side + extend the `Alert` DTO

Both surfaces flow through `rowToAlert()` in `calderyn.server.ts`, so attaching here covers them at once.

**Files:**
- Modify: `app/lib/types.ts` (the `Alert` interface, ~line 35-54)
- Modify: `app/lib/calderyn.server.ts` (`rowToAlert`, ~line 126-144)
- Test: `app/lib/__tests__/row-to-alert-remediation.test.ts` (new)

- [ ] **Step 1: Add fields to the `Alert` interface**

In `app/lib/types.ts`, add the import at the top of the file (after the existing `ship-cost/types` import):

```typescript
import type { RemediationPlan } from "./remediation/types";
```

Then add two optional fields to the `Alert` interface, immediately after `evidence: Record<string, any>;`:

```typescript
  /** Strategic remediation for product-economics detectors (computed on read in
   *  rowToAlert). Null for other detectors. */
  remediation: RemediationPlan | null;
  /** One-to-two sentence plain-language synopsis derived from the remediation
   *  plan. Empty string when there is no plan. */
  rec_detail: string;
```

- [ ] **Step 2: Write a failing test for the attach**

```typescript
// app/lib/__tests__/row-to-alert-remediation.test.ts
import { describe, it, expect } from "vitest";
import { attachRemediation } from "../calderyn.server";
import type { Alert } from "../types";

function baseAlert(p: Partial<Alert>): Alert {
  return {
    id: "a1",
    detector_id: "negative_unit_economics",
    severity: "high",
    status: "open",
    dollar_impact: 530449,
    claude_rank: 1,
    created_at: "2026-06-20T00:00:00Z",
    title: "Summit Logo Tee — M",
    narrative: "Acquisition cost is pushing the net per unit below zero.",
    campaign: null,
    campaign_id: null,
    campaign_external_id: null,
    sku: "Summit Logo Tee — M",
    evidence: {},
    remediation: null,
    rec_detail: "",
    ...p,
  };
}

describe("attachRemediation", () => {
  it("fills remediation + synopsis for a product-economics alert", () => {
    const a = attachRemediation(
      baseAlert({
        evidence: { gross_unit_margin_usd: 23, cac_per_unit_usd: 170, net_per_unit_usd: -147 },
      }),
    );
    expect(a.remediation?.recommended).toBe("reallocate_to_winner");
    expect(a.rec_detail).toContain("$170");
  });

  it("leaves non-product-economics alerts untouched (null plan, empty synopsis)", () => {
    const a = attachRemediation(baseAlert({ detector_id: "sku_stockout_vs_spend" }));
    expect(a.remediation).toBeNull();
    expect(a.rec_detail).toBe("");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run app/lib/__tests__/row-to-alert-remediation.test.ts`
Expected: FAIL — `attachRemediation` is not exported.

- [ ] **Step 4: Implement `attachRemediation` and call it in `rowToAlert`**

In `app/lib/calderyn.server.ts`, add imports near the top (with the other `./` imports):

```typescript
import { rankMoves, toNumericEvidence } from "./remediation/rank";
import { synopsisFor } from "./remediation/synopsis";
import type { RemediationInput } from "./remediation/types";
import type { DetectorId } from "./types";
```

Add the exported helper (place it directly above `rowToAlert`):

```typescript
const PRODUCT_ECON_DETECTORS: ReadonlySet<DetectorId> = new Set<DetectorId>([
  "negative_unit_economics",
  "ad_tax_overload",
  "return_rate_hidden_loss",
  "margin_erosion",
  "cogs_drift",
]);

/** Compute the remediation plan + synopsis for product-economics alerts and
 *  attach them to the Alert. Pure, no I/O — evidence already carries the per-unit
 *  economics the engine needs. Exported for unit tests. */
export function attachRemediation(a: Alert): Alert {
  if (!PRODUCT_ECON_DETECTORS.has(a.detector_id)) {
    return { ...a, remediation: null, rec_detail: "" };
  }
  const input: RemediationInput = {
    detectorId: a.detector_id,
    dollarImpactCents: a.dollar_impact,
    evidence: toNumericEvidence(a.evidence),
  };
  const plan = rankMoves(input);
  return { ...a, remediation: plan, rec_detail: synopsisFor(plan, input) };
}
```

Then update `rowToAlert` so its returned object includes the new fields and is run through `attachRemediation`. Change the final `return { ... };` of `rowToAlert` to build the object then attach:

```typescript
function rowToAlert(r: Record<string, unknown>): Alert {
  const base: Alert = {
    id: String(r.id),
    detector_id: r.detector_id as Alert["detector_id"],
    severity: r.severity as Alert["severity"],
    status: r.status as Alert["status"],
    dollar_impact: Math.round(Number(r.dollar_impact ?? 0) * 100),
    claude_rank: Number(r.claude_rank ?? 999),
    created_at: String(r.created_at),
    title: String(r.title ?? ""),
    narrative: String(r.narrative ?? ""),
    campaign: (r.campaign as string | null) ?? null,
    campaign_id: (r.campaign_id as string | null) ?? null,
    campaign_external_id: (r.campaign_external_id as string | null) ?? null,
    sku: (r.sku as string | null) ?? null,
    evidence: (r.evidence as Record<string, unknown>) ?? {},
    remediation: null,
    rec_detail: "",
  };
  return attachRemediation(base);
}
```

(Ensure `Alert` is imported in `calderyn.server.ts` — it already is via the existing `rowToAlert` return type; if not, add `import type { Alert } from "./types";`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run app/lib/__tests__/row-to-alert-remediation.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck (the new non-optional `Alert` fields must be satisfied everywhere `Alert` is constructed)**

Run: `npx tsc --noEmit`
Expected: exit 0. If the embedded loader or seed builds an `Alert` literal, add `remediation: null, rec_detail: ""` there. Search: `grep -rn "detector_id:" app/lib/seed app/routes/app.alerts.$id.tsx`.

- [ ] **Step 7: Commit**

```bash
git add app/lib/types.ts app/lib/calderyn.server.ts app/lib/__tests__/row-to-alert-remediation.test.ts
git commit -m "calderyn.server: attach remediation plan + synopsis in rowToAlert"
```

---

## Task 6: DTO passthrough — `AlertVM` + `adaptAlert`

**Files:**
- Modify: `app/components/dashboard/view-models.ts` (`AlertVM`, ~line 36-53)
- Modify: `app/lib/dashboard/client.ts` (`adaptAlert`, ~line 147-195)
- Test: `app/lib/dashboard/__tests__/adapt-alert.test.ts` (new)

- [ ] **Step 1: Add `remediation` to `AlertVM`**

In `app/components/dashboard/view-models.ts`, add the import at the top:

```typescript
import type { RemediationPlan } from "~/lib/remediation/types";
```

Add to the `AlertVM` interface after `rec_detail: string;`:

```typescript
  remediation: RemediationPlan | null;
```

- [ ] **Step 2: Write a failing test**

```typescript
// app/lib/dashboard/__tests__/adapt-alert.test.ts
import { describe, it, expect } from "vitest";
import { adaptAlert } from "../client";
import type { Alert } from "~/lib/types";

function alert(p: Partial<Alert>): Alert {
  return {
    id: "a1",
    detector_id: "negative_unit_economics",
    severity: "high",
    status: "open",
    dollar_impact: 530449,
    claude_rank: 1,
    created_at: "2026-06-20T00:00:00Z",
    title: "Summit Logo Tee — M",
    narrative: "n",
    campaign: null,
    campaign_id: null,
    campaign_external_id: null,
    sku: "Summit Logo Tee — M",
    evidence: { gross_unit_margin_usd: 23, cac_per_unit_usd: 170 },
    remediation: {
      moves: [
        { kind: "reallocate_to_winner", dollarImpactCents: 530449, executor: null, label: "x" },
        { kind: "snooze", dollarImpactCents: 0, executor: "snooze_alert", label: "Snooze" },
      ],
      recommended: "reallocate_to_winner",
      structurallyDead: false,
    },
    rec_detail: "synopsis here",
    ...p,
  };
}

describe("adaptAlert remediation passthrough", () => {
  it("passes remediation + rec_detail through to the view model", () => {
    const vm = adaptAlert(alert({}), []);
    expect(vm.remediation?.recommended).toBe("reallocate_to_winner");
    expect(vm.rec_detail).toBe("synopsis here");
  });

  it("non-product alerts keep the legacy campaign-gated actions", () => {
    const vm = adaptAlert(
      alert({ detector_id: "sku_stockout_vs_spend", remediation: null, rec_detail: "", campaign_id: "c1" }),
      [{ id: "c1", name: "C", daily_budget_cents: 1000 } as never],
    );
    expect(vm.remediation).toBeNull();
    expect(vm.actions).toContain("pause_campaign");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run app/lib/dashboard/__tests__/adapt-alert.test.ts`
Expected: FAIL — `vm.remediation` is undefined (not yet passed through).

- [ ] **Step 4: Update `adaptAlert`**

In `app/lib/dashboard/client.ts`, replace the `rec_detail: "", // TODO(api)...` line and add `remediation` in the returned object. The return becomes:

```typescript
  return {
    id: a.id,
    detector_id: a.detector_id,
    severity: a.severity,
    status: a.status,
    claude_rank: a.claude_rank,
    dollar_impact: a.dollar_impact,
    created_at: a.created_at,
    title: a.title,
    narrative: a.narrative,
    campaign: a.campaign,
    sku: a.sku,
    evidence,
    campaign_id,
    actions,
    recommended,
    rec_detail: a.rec_detail ?? "",
    remediation: a.remediation ?? null,
  };
```

(Leave the existing `actions` / `recommended` derivation above it unchanged — non-product alerts still use it; the panel in Task 8 prefers `remediation` when present.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run app/lib/dashboard/__tests__/adapt-alert.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add app/components/dashboard/view-models.ts app/lib/dashboard/client.ts app/lib/dashboard/__tests__/adapt-alert.test.ts
git commit -m "dashboard: pass remediation plan through adaptAlert to AlertVM"
```

---

## Task 7: Labels + icons for the new move kinds

**Files:**
- Modify: `app/components/dashboard/format.ts` (`ACTION_LABELS`, ~line 85-92)
- Modify: `app/components/dashboard/icons.tsx` (`CD_ACTION_ICON`, ~line 112)

- [ ] **Step 1: Confirm the icon names exist in the registry**

Run: `grep -n "ban\|trending\|undo\|tag\|rotate\|scissors\|shield\|bolt" app/components/dashboard/icons.tsx`
Expected: shows which Lucide names are already registered in `CD_ICONS`. Use only names already present; if a needed one is absent, add it to `CD_ICONS` per the CLAUDE.md icon rule (import from `lucide-react`, one line in `CD_ICONS`).

- [ ] **Step 2: Add move-kind labels**

In `app/components/dashboard/format.ts`, extend `ACTION_LABELS` with the move kinds (these double as fallbacks; the panel uses `move.label` from the engine, but keep labels here for any `CD_ACTION_ICON`/label lookups):

```typescript
  // remediation move kinds (Phase 1 advisory)
  discontinue: "Stop reordering",
  cut_ads: "Cut ad spend",
  reallocate_to_winner: "Reallocate to a winner",
  fix_returns: "Fix returns",
  review_pricing: "Review pricing",
```

- [ ] **Step 3: Add move-kind icons**

In `app/components/dashboard/icons.tsx`, extend `CD_ACTION_ICON` (use icon names confirmed present in Step 1; the right column shows safe defaults that already exist in the registry per the icons file):

```typescript
  discontinue: "ban",
  cut_ads: "scissors",
  reallocate_to_winner: "trendingUp",
  fix_returns: "rotateCcw",
  review_pricing: "tag",
```

If any of `ban`/`scissors`/`trendingUp`/`rotateCcw`/`tag` is NOT in `CD_ICONS`, either add it (one import + one registry line) or substitute an existing name (e.g. `bolt`). The panel already falls back to `"bolt"` for unknown kinds, so this step is non-blocking.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/components/dashboard/format.ts app/components/dashboard/icons.tsx
git commit -m "dashboard: labels + icons for remediation move kinds"
```

---

## Task 8: Dashboard Fix-it panel — render synopsis + ranked moves

Render the synopsis and the ranked advisory moves. The recommended move is emphasized; advisory moves are non-clickable guidance rows; **Snooze stays the one executable button.**

**Files:**
- Modify: `app/components/dashboard/screens/Alerts.tsx` (the Fix-it `Card`, lines ~244-282)

- [ ] **Step 1: Replace the Fix-it card body**

In `AlertDetail`, replace the existing Fix-it `Card` (the block from `<Card className="flex flex-col gap-2.5">` through its closing `</Card>`) with this. It branches: when `alert.remediation` exists (product-economics), render synopsis + ranked moves; otherwise fall back to the existing `alert.actions` buttons.

```tsx
          <Card className="flex flex-col gap-2.5">
            <h2 className="cd-h2">Fix it</h2>
            {resolved ? (
              <p className="cd-caption">
                This alert was resolved with{" "}
                <b style={{ color: "var(--text-1)" }}>{resolvedLabel}</b>. The action is logged in
                your audit history and can be reverted there.
              </p>
            ) : alert.remediation ? (
              <>
                {alert.rec_detail && (
                  <p className="cd-body" style={{ maxWidth: "52ch" }}>
                    {alert.rec_detail}
                  </p>
                )}
                <div className="flex flex-col gap-2 mt-1">
                  {alert.remediation.moves.map((m) => {
                    const rec = m.kind === alert.remediation!.recommended;
                    // Phase 1: only snooze executes; other moves are advisory guidance.
                    if (m.executor === "snooze_alert") {
                      return (
                        <button
                          key={m.kind}
                          disabled={resolved || busy}
                          aria-busy={busy && attempted === "snooze_alert"}
                          className="cd-action-btn"
                          onClick={() => run("snooze_alert" as ActionKind)}
                        >
                          <CDIcon name={CD_ACTION_ICON.snooze_alert || "bell"} size={16} strokeWidth={1.9} />
                          <span className="flex-1 text-left">Snooze</span>
                        </button>
                      );
                    }
                    return (
                      <div
                        key={m.kind}
                        className={"cd-move-row" + (rec ? " rec" : "")}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "10px 12px",
                          borderRadius: 10,
                          border: "1px solid var(--border)",
                          background: rec ? "var(--surface-2)" : "transparent",
                        }}
                      >
                        <CDIcon name={CD_ACTION_ICON[m.kind] || "bolt"} size={16} strokeWidth={1.9} />
                        <span className="flex-1 text-left">{m.label}</span>
                        {rec && <span className="cd-rec-tag">Recommended</span>}
                      </div>
                    );
                  })}
                </div>
                <p className="cd-caption mt-1" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <CDIcon name="shield" size={13} /> Guardrails apply — every action is reversible and
                  logged. One-click execution for these moves is rolling out.
                </p>
              </>
            ) : (
              <>
                {alert.rec_detail && <p className="cd-caption">{alert.rec_detail}</p>}
                <div className="flex flex-col gap-2 mt-1">
                  {alert.actions.map((kind) => {
                    const rec = kind === alert.recommended;
                    return (
                      <button
                        key={kind}
                        disabled={resolved || busy}
                        aria-busy={busy && attempted === kind}
                        className={"cd-action-btn" + (rec ? " rec" : "")}
                        onClick={() => run(kind as ActionKind)}
                      >
                        <CDIcon name={CD_ACTION_ICON[kind] || "bolt"} size={16} strokeWidth={1.9} />
                        <span className="flex-1 text-left">{ACTION_LABELS[kind] || kind}</span>
                        {rec && <span className="cd-rec-tag">Recommended</span>}
                      </button>
                    );
                  })}
                </div>
                <p className="cd-caption mt-1" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <CDIcon name="shield" size={13} /> Guardrails apply — every action is reversible and
                  logged.
                </p>
              </>
            )}
          </Card>
```

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint app/components/dashboard/screens/Alerts.tsx`
Expected: exit 0. (`CD_ACTION_ICON` keys are `string`-indexed, so `CD_ACTION_ICON[m.kind]` is fine.)

- [ ] **Step 3: Manual verification (no component test harness in this repo)**

Run the dashboard against seed data and open a `negative_unit_economics` alert detail.
Run: `npm run dev` (or the repo's documented dev command) and navigate to the Summit Logo Tee alert.
Expected: the Fix-it panel shows the synopsis paragraph, "Move ad budget to a higher-margin product" tagged **Recommended**, "Cut the ad spend…" as a second guidance row, and a working **Snooze** button. It must NOT say "Stop reordering".

- [ ] **Step 4: Commit**

```bash
git add app/components/dashboard/screens/Alerts.tsx
git commit -m "dashboard/Alerts: render remediation synopsis + ranked moves"
```

---

## Task 9: Embedded app Fix-it panel (Polaris) — parity

The embedded app reads the raw `Alert` (now carrying `remediation` + `rec_detail`) directly. Mirror the panel in Polaris.

**Files:**
- Modify: `app/routes/app.alerts.$id.tsx` (the "Recommended actions" `Card`, ~lines 524-573)

- [ ] **Step 1: Render the synopsis + moves when a plan is present**

Inside the "Recommended actions" `Card`, immediately after the `<Text as="p" variant="headingLg">{fmtMoney(alert.dollar_impact)}</Text>` block and before the `allowedActions.map(...)` `BlockStack`, insert a remediation block. Add this just inside the inner `<BlockStack gap="300">` that wraps the actions:

```tsx
                {alert.remediation && (
                  <BlockStack gap="200">
                    {alert.rec_detail && (
                      <Text as="p" variant="bodyMd">
                        {alert.rec_detail}
                      </Text>
                    )}
                    {alert.remediation.moves
                      .filter((m) => m.executor !== "snooze_alert")
                      .map((m) => {
                        const rec = m.kind === alert.remediation!.recommended;
                        return (
                          <InlineStack key={m.kind} gap="150" blockAlign="center" wrap={false}>
                            {rec && <Badge tone="success">Recommended</Badge>}
                            <Text as="span" variant="bodyMd" fontWeight={rec ? "semibold" : "regular"}>
                              {m.label}
                            </Text>
                          </InlineStack>
                        );
                      })}
                    <Text as="p" variant="bodyXs" tone="subdued">
                      One-click execution for these moves is rolling out. You can still snooze below.
                    </Text>
                  </BlockStack>
                )}
```

(`InlineStack`, `Badge`, `Text`, `BlockStack` are already imported in this file — confirm with `grep -n "InlineStack\|Badge" app/routes/app.alerts.$id.tsx`. If `Badge` is missing from the import, add it to the `@shopify/polaris` import list.)

- [ ] **Step 2: Keep Snooze working**

The existing `allowedActions.map(...)` still renders below — `snooze_alert` continues to flow through the existing modal/confirm path. Do not remove it. (Product-economics alerts include `snooze_alert` in `allowedActions` via the existing detector→actions mapping.)

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint app/routes/app.alerts.$id.tsx`
Expected: exit 0. The loader passes the raw `Alert`, which now includes `remediation` and `rec_detail`, so `alert.remediation` is typed.

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.alerts.$id.tsx
git commit -m "app.alerts.$id: mirror remediation synopsis + moves (Polaris)"
```

---

## Task 10: Full gate + final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full remediation test suite**

Run: `npx vitest run app/lib/remediation app/lib/__tests__/row-to-alert-remediation.test.ts app/lib/dashboard/__tests__/adapt-alert.test.ts`
Expected: PASS (all engine, synopsis, attach, and adaptAlert tests green).

- [ ] **Step 2: Run the repo pre-commit gate (per CLAUDE.md)**

Run: `npm run typecheck && npm run lint && npm run build && npm test`
Expected: each exits 0. Fix root causes; do not `--no-verify`, disable lint, or narrow types to silence `tsc`.

- [ ] **Step 3: Patch sanity**

Run: `git diff --check` and `git log --oneline -10`
Expected: no whitespace errors; no stray `console.log`, `.only`, or commented-out blocks in the diff.

- [ ] **Step 4: `/code-review` the branch and resolve blockers**

Run the `/code-review` slash command on the working tree; resolve every blocker, downgrade nits with a one-line justification.

---

## Self-review (against the spec)

- **Spec §"The deterministic ranking":** Tasks 2–3 implement the gate + all 5 detectors + the move table. ✓
- **Spec §"Worked example":** Task 2 test asserts Summit → `reallocate_to_winner`, not discontinue. ✓
- **Spec §"Architecture (Approach A)" / shared engine:** Task 5 attaches in `rowToAlert` (single seam, both surfaces). ✓
- **Spec §"Failure visibility":** synopsis never empty (Task 4 test); non-product alerts untouched (Task 5/6 tests). ✓
- **Spec §"Dashboard parity":** Tasks 8 (dashboard) + 9 (embedded Polaris). ✓
- **Deferred (stated in Scope):** DB column/migration, AI prose, named winner, executors → Phases 2–4. ✓
- **Type consistency:** `MoveKind`, `StrategicMove.executor: "snooze_alert" | null`, `RemediationPlan.recommended: MoveKind | null` are used identically across rank.ts, synopsis.ts, calderyn.server.ts, view-models.ts, and both panels. ✓
- **No placeholders:** every code step contains complete code; UI tasks ship full JSX. ✓
