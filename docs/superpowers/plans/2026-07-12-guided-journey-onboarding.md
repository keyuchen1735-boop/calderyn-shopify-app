# Guided Journey Onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three onboarding paper-cut fixes (gauge race, login Shopify button, add-product overload), then replace Home's static setup checklist with a persistent 3-phase guided journey (Foundation → Launch → First wins) with completion toasts, a "You're live" moment, and a retirement recap.

**Architecture:** Milestones are derived from existing shop data by `app/lib/onboarding/journey.server.ts` and materialized (insert-only, sticky) into a new `shop_setup_progress` table. A `dashboard.api.setup-progress` resource route serves `{steps, phase, retired, …}` through the session screen-cache. The Home card renders phases from a client-safe pure model (`journey-model.ts`); a watcher in `DashboardApp` diffs payloads to fire completion toasts anywhere in the app.

**Tech Stack:** Remix 2.16.7 (pinned — no dependency changes), React 18, `cd-*` design system, GSAP via `useGSAP`, Supabase Postgres (service-role client, explicit `.eq("shop_id", …)` on every query), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-12-guided-journey-onboarding-design.md` (in the main checkout; copy travels with this branch).

## Global Constraints

- TypeScript strict; no `any` without written justification. `npx tsc --noEmit` (via `npm run typecheck`) is authoritative.
- Every dashboard API route: `requireDashboardSession(request)` first; `requireSameOrigin` (from `~/lib/dashboard/http.server`) on writes; shop id from the session only.
- The service-role Supabase client bypasses RLS — every table query MUST carry `.eq("shop_id", session.shopId)` (see `app/lib/dashboard/session.server.ts:139-141`).
- UI: `cd-*` primitives only (`Card`, `Btn`, etc. from `app/components/dashboard/ui.tsx`); Lucide icons via `CDIcon` registry only; no new deps.
- No browser-visible comments/strings implying AI generation, prototypes, or provenance (CLAUDE.md "Browser-visible source hygiene").
- Keep all `@remix-run/*` pinned at exact 2.16.7; do not touch dependency versions.
- Tests: `npx vitest run <path>`; vitest includes `app/**/*.test.ts(x)`.
- Pre-commit gate per PR: `npm run typecheck` → `npm run lint` → `npm run build`, all exit 0, plus `/code-review` on the working tree.
- Worktree: all work happens in `C:\Users\famou\Desktop\calderyn-onboarding` (worktree of `origin/main`). Part B tasks each get their own short-lived branch off `origin/main`; Part A tasks go on `feat/onboarding-journey` (already created).
- Local verification recipe: source `.env.devserver.local` + `.env.local`, `npx prisma generate` (kill any running vite:dev first — EPERM gotcha), `npm run dev`, open `http://localhost:3000/dashboard`.

---

# PART B — paper-cut fixes (three small PRs, ship first)

### Task 1: Home gauge race — never sweep to a stale pct

**Branch:** `git checkout -b fix/home-gauge-race origin/main`

**Files:**
- Create: `app/components/dashboard/screens/home-gauge.ts`
- Create: `app/components/dashboard/screens/__tests__/home-gauge.test.ts`
- Modify: `app/components/dashboard/screens/Dashboard.tsx:685-696` (TickGauge props)

**Interfaces:**
- Produces: `homeGaugeView(booted: boolean, dormant: boolean, pct: number | null): { pct: number; pending: boolean }`

**Background:** `TickGauge` (`app/components/dashboard/ui.tsx:700-733`) re-sweeps from 0 on every `target` change (`revertOnUpdate: true`, deps `[target]`). Today `pct={dormant ? 0 : (pct ?? 0)}` — the calibration fetch can land before `app.booted`, sweeping to a stale pct (e.g. 47), then `dormant` resolves true and the gauge drops to 0. Fix: hold the gauge at 0/pending until `app.booted` so it resolves exactly once.

- [ ] **Step 1: Write the failing test**

`app/components/dashboard/screens/__tests__/home-gauge.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { homeGaugeView } from "../home-gauge";

describe("homeGaugeView", () => {
  it("holds at 0/pending before boot, even when a stale pct already arrived", () => {
    expect(homeGaugeView(false, false, 47)).toEqual({ pct: 0, pending: true });
  });
  it("stays at 0 (not pending) once booted and dormant", () => {
    expect(homeGaugeView(true, true, 47)).toEqual({ pct: 0, pending: false });
  });
  it("resolves to the real pct once booted and not dormant", () => {
    expect(homeGaugeView(true, false, 55)).toEqual({ pct: 55, pending: false });
  });
  it("treats a missing pct as 0 after boot", () => {
    expect(homeGaugeView(true, false, null)).toEqual({ pct: 0, pending: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/components/dashboard/screens/__tests__/home-gauge.test.ts`
Expected: FAIL — cannot resolve `../home-gauge`.

- [ ] **Step 3: Implement**

`app/components/dashboard/screens/home-gauge.ts`:

```ts
// Home Autopilot gauge view state. The gauge sweeps from 0 on every target
// change (TickGauge sweepFrom0), so it must not receive a calibration pct
// until boot has decided whether the store is dormant — otherwise a stale
// row sweeps the dial up and dormancy immediately drops it back to 0.
export function homeGaugeView(
  booted: boolean,
  dormant: boolean,
  pct: number | null,
): { pct: number; pending: boolean } {
  if (!booted) return { pct: 0, pending: true };
  if (dormant) return { pct: 0, pending: false };
  return { pct: pct ?? 0, pending: false };
}
```

In `Dashboard.tsx`: import `homeGaugeView`, compute `const gauge = homeGaugeView(app.booted, dormant, pct);` next to the existing `dormant` computation (line ~340), and change the TickGauge call (lines 689–694) to:

```tsx
<TickGauge pct={gauge.pct} size={108} sweepFrom0 pending={gauge.pending} />
```

(The old `pending={!app.booted && pct === null}` and `pct={dormant ? 0 : (pct ?? 0)}` are replaced entirely.)

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run app/components/dashboard/screens/__tests__/home-gauge.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Manual verify**

Local dev recipe → open Home on the demo shop (established store: gauge sweeps once to its real pct, no double-sweep) and on a fresh store (calderyn-test after reset: dial holds empty, "standing by", never flashes a number).

- [ ] **Step 6: Gate + commit + PR**

`npm run typecheck && npm run lint && npm run build` — all exit 0. Then:

```bash
git add app/components/dashboard/screens/home-gauge.ts app/components/dashboard/screens/__tests__/home-gauge.test.ts app/components/dashboard/screens/Dashboard.tsx
git commit -m "dashboard/Home: hold Autopilot gauge until boot resolves dormancy"
```

Push and open PR (title: `dashboard/Home: fix gauge sweep race on fresh stores`). Merge before Task 4+ (Part A also touches Dashboard.tsx).

---

### Task 2: Login "Continue with Shopify" → signup + import intent

**Branch:** `git checkout -b fix/login-shopify-signup origin/main`

**Files:**
- Modify: `app/components/auth/AuthCard.tsx:160-183` (ShopifyButton)
- Create: `app/components/auth/shopify-button-href.test.ts`
- Modify: `app/routes/login.tsx:53`
- Modify: `app/routes/signup.tsx` (loader ~lines 22–33, JSX ~line 43)

**Interfaces:**
- Produces: `shopifyButtonHref(baseUrl: string | null | undefined, returnTo: string | null | undefined, mode: "login" | "signup"): string` (exported from AuthCard.tsx)
- ShopifyButton gains optional prop `mode?: "login" | "signup"` (default `"login"` — the onboarding/import surfaces that still want direct OAuth are unchanged).

**Background:** The login page's Shopify button links to `/dashboard/login`, which 302s straight into Shopify OAuth — a dead end for a visitor with no Calderyn account or connected shop. New users should land on signup; the existing post-signup onboarding (`dashboard.onboarding.tsx` ImportStep) already offers "Connect Shopify" right after.

- [ ] **Step 1: Write the failing test**

`app/components/auth/shopify-button-href.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shopifyButtonHref } from "./AuthCard";

describe("shopifyButtonHref", () => {
  it("login mode keeps the direct OAuth start", () => {
    expect(shopifyButtonHref("https://calderyncompany.com", null, "login")).toBe(
      "https://calderyncompany.com/dashboard/login",
    );
  });
  it("login mode threads return_to", () => {
    expect(shopifyButtonHref("", "/dashboard?x=1", "login")).toBe(
      "/dashboard/login?return_to=%2Fdashboard%3Fx%3D1",
    );
  });
  it("signup mode routes to signup with the shopify marker", () => {
    expect(shopifyButtonHref("https://calderyncompany.com", null, "signup")).toBe(
      "https://calderyncompany.com/signup?from=shopify",
    );
  });
  it("signup mode threads return_to after the marker", () => {
    expect(shopifyButtonHref("", "/dashboard", "signup")).toBe(
      "/signup?from=shopify&return_to=%2Fdashboard",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/components/auth/shopify-button-href.test.ts`
Expected: FAIL — `shopifyButtonHref` is not exported.

- [ ] **Step 3: Implement**

In `AuthCard.tsx`, above `ShopifyButton`:

```ts
// Where the Shopify button leads. "login" starts Shopify OAuth directly
// (existing connected-shop flows); "signup" sends a brand-new visitor to
// account creation first — onboarding offers Connect Shopify right after,
// so the import intent survives without a dead-end OAuth bounce.
export function shopifyButtonHref(
  baseUrl: string | null | undefined,
  returnTo: string | null | undefined,
  mode: "login" | "signup",
): string {
  const path =
    mode === "signup"
      ? `/signup?from=shopify${returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : ""}`
      : returnTo
        ? `/dashboard/login?return_to=${encodeURIComponent(returnTo)}`
        : "/dashboard/login";
  return `${baseUrl ?? ""}${path}`;
}
```

Change `ShopifyButton` to accept `mode = "login"` and use the helper:

```tsx
export function ShopifyButton({
  label,
  returnTo,
  baseUrl,
  mode = "login",
}: {
  label: string;
  returnTo?: string | null;
  baseUrl?: string;
  mode?: "login" | "signup";
}) {
  const href = shopifyButtonHref(baseUrl, returnTo ?? null, mode);
  return (
    <a className="cd-auth-google" href={href}>
      <CDIcon name="store" size={16} />
      {label}
    </a>
  );
}
```

(Keep the existing `__Host-` state-cookie comment on the props — it still applies to login mode.)

In `login.tsx` line 53, pass the new mode:

```tsx
<ShopifyButton label="Continue with Shopify" returnTo={returnTo} baseUrl={authBase} mode="signup" />
```

In `signup.tsx`: add `fromShopify: url.searchParams.get("from") === "shopify"` to the loader's returned object, destructure it in the component, and render directly under the page's subtitle (above the GoogleButton at ~line 43):

```tsx
{fromShopify && (
  <p className="cd-auth-sub">
    Create your account first — you'll connect your Shopify store and import
    everything right after.
  </p>
)}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run app/components/auth/shopify-button-href.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Manual verify**

Local dev: `/login` → "Continue with Shopify" lands on `/signup?from=shopify` showing the note; complete signup → onboarding step 2 offers "Connect Shopify". Direct `/dashboard/login` still starts OAuth (unchanged).

- [ ] **Step 6: Gate + commit + PR**

Gate green, then:

```bash
git add app/components/auth/AuthCard.tsx app/components/auth/shopify-button-href.test.ts app/routes/login.tsx app/routes/signup.tsx
git commit -m "auth/login: route Shopify button to signup + import intent"
```

Push, open PR.

---

### Task 3: NewProductFlow diet — variants disclosure, shipping question, copy trim

**Branch:** `git checkout -b feat/new-product-flow-diet origin/main`

**Files:**
- Create: `app/components/dashboard/screens/new-product-copy.ts`
- Create: `app/components/dashboard/screens/__tests__/new-product-copy.test.ts`
- Modify: `app/components/dashboard/screens/NewProductFlow.tsx` (Details step: ~1015–1098; state ~246–274)
- Modify: `app/styles/dashboard.css` (append `.cd-npf-combo-summary`, `.cd-npf-shipq` rules)

**Interfaces:**
- Produces: `variantSummary(count: number, basePrice: string): string`

**Background (main version is a 4-step wizard):** In the Details step, `ComboTable` (per-combination price/stock grid) renders whenever option rows parse — with Size×Color that's a wall of inputs. Shipping is a "Physical product (requires shipping)" checkbox + `Weight (g)` + `Box (L × W × H, mm)` fields users didn't understand. Organize (Vendor/Tags/Collections) reads as mandatory.

- [ ] **Step 1: Write the failing test**

`app/components/dashboard/screens/__tests__/new-product-copy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { variantSummary } from "../new-product-copy";

describe("variantSummary", () => {
  it("summarizes combos with a base price", () => {
    expect(variantSummary(6, "24.99")).toBe(
      "6 variants — all $24.99 unless you change them",
    );
  });
  it("summarizes without a price", () => {
    expect(variantSummary(2, "")).toBe("2 variants — same price and stock");
  });
  it("uses the singular for one variant", () => {
    expect(variantSummary(1, "")).toBe("1 variant — same price and stock");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/components/dashboard/screens/__tests__/new-product-copy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the copy helper**

`app/components/dashboard/screens/new-product-copy.ts`:

```ts
// One-line summary shown instead of the per-variant grid until the merchant
// asks for it — the grid is the single heaviest element in the flow.
export function variantSummary(count: number, basePrice: string): string {
  const n = `${count} variant${count === 1 ? "" : "s"}`;
  const price = basePrice.trim();
  return price ? `${n} — all $${price} unless you change them` : `${n} — same price and stock`;
}
```

Run: `npx vitest run app/components/dashboard/screens/__tests__/new-product-copy.test.ts` — 3 passed. Commit:

```bash
git add app/components/dashboard/screens/new-product-copy.ts app/components/dashboard/screens/__tests__/new-product-copy.test.ts
git commit -m "dashboard/NewProductFlow: add variant summary copy helper"
```

- [ ] **Step 4: Collapse the combo table behind the summary**

In `NewProductFlow.tsx`: add state near the other display state (~line 250):

```ts
const [combosOpen, setCombosOpen] = useState(false);
```

Replace the `<ComboTable …/>` render site (inside the "Sizes & colors" section, ~lines 1016–1035) — keep `OptionRows` as-is, then:

```tsx
{combos.length > 0 && !combosOpen && (
  <button
    type="button"
    className="cd-npf-combo-summary"
    onClick={() => setCombosOpen(true)}
  >
    {variantSummary(combos.length, price)}
    <span className="cd-npf-combo-edit">Edit each</span>
  </button>
)}
{combos.length > 0 && combosOpen && (
  <>
    <ComboTable
      combos={combos}
      cells={cells}
      onCell={(label, patch) => setCells((c) => mergeCell(c, label, patch))}
      basePlaceholder={price || undefined}
    />
    <button type="button" className="cd-npf-combo-summary" onClick={() => setCombosOpen(false)}>
      Done
    </button>
  </>
)}
```

Import `variantSummary` from `./new-product-copy`.

- [ ] **Step 5: Shipping becomes one question**

Replace the physical-checkbox block (~lines 1041–1074). Keep `data-f="shipping"`, `physical` / `weight` / `dims` state, and the existing weight/dims `Field`s (only their labels change):

```tsx
<SectionTitle>Shipping</SectionTitle>
<div className="cd-npf-shipq">
  <span className="cd-npf-shipq-l">Does this ship in a box?</span>
  <div className="cd-npf-shipq-btns">
    <Btn small kind={physical ? "primary" : undefined} onClick={() => setPhysical(true)}>
      Yes
    </Btn>
    <Btn small kind={!physical ? "primary" : undefined} onClick={() => setPhysical(false)}>
      No
    </Btn>
  </div>
</div>
{physical ? (
  /* existing Weight + Box fields, relabeled: */
  // <Field label="Weight (grams)"> …existing input…
  // <Field label="Box size (L × W × H, mm)"> …existing inputs…
) : (
  <p className="cd-caption">No shipping needed — digital, service, or pickup-only.</p>
)}
```

(`Btn` accepts `kind`/`small` — same usage as Dashboard.tsx. Completeness logic `shippingDone` and the `incomplete_shipping` save error are unchanged.)

- [ ] **Step 6: Copy trim on Organize**

Retitle the Organize section (~line 1078) and add one qualifier line; field labels unchanged:

```tsx
<SectionTitle>Organize</SectionTitle>
<p className="cd-caption">Optional — helps group products later. Fine to skip.</p>
```

- [ ] **Step 7: CSS**

Append to `app/styles/dashboard.css` (match existing token usage in the file):

```css
/* New-product flow: collapsed variant grid + shipping question */
.cd-npf-combo-summary {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  width: 100%; padding: 10px 12px; border: 1px dashed var(--line);
  border-radius: 10px; background: transparent; color: var(--text);
  font: inherit; cursor: pointer; text-align: left;
}
.cd-npf-combo-summary:hover { border-color: var(--accent); }
.cd-npf-combo-edit { color: var(--accent); font-size: 0.85em; }
.cd-npf-shipq { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.cd-npf-shipq-btns { display: flex; gap: 6px; }
```

(If `--line` / `--accent` aren't this stylesheet's token names, use the ones the neighboring `cd-npf-*` or `cd-su-*` rules use — copy from the nearest existing rule, don't invent tokens.)

- [ ] **Step 8: Run all flow tests + manual verify**

Run: `npx vitest run app/components/dashboard/screens/__tests__/` — all pass.
Manual: local dev → Products → New product → prompt "t shirt for my brand" → Details step: add Sizes + Colors → grid is collapsed behind "6 variants — all $X unless you change them"; expand/collapse works; shipping shows the Yes/No question; No hides weight/dims and readiness chip "Shipping" is done; save with Yes + empty weight still raises `incomplete_shipping` and glows the field.

- [ ] **Step 9: Gate + commit + PR**

Gate green, then:

```bash
git add app/components/dashboard/screens/NewProductFlow.tsx app/styles/dashboard.css
git commit -m "dashboard/NewProductFlow: collapse variant grid, plain shipping question, copy trim"
```

Push, open PR. Note in the PR body: `NewProductFlow.tsx` and `dashboard.css` carry unrelated WIP on `feat/autopilot-agentic-redesign` — flag the overlap for whoever lands that branch.

---

# PART A — the guided journey (branch `feat/onboarding-journey`)

Rebase `feat/onboarding-journey` onto main after Tasks 1–3 merge (`git fetch origin && git rebase origin/main`).

### Task 4: `shop_setup_progress` migration

**Files:**
- Create: `supabase/migrations/20260713090000_shop_setup_progress.sql`

**Interfaces:**
- Produces: table `shop_setup_progress(shop_id uuid, milestone_key text, completed_at timestamptz)` — PK `(shop_id, milestone_key)`; service-role only. Also stores marker rows (`live_card_dismissed`, `recap_dismissed`) that are not milestones.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260713090000_shop_setup_progress.sql
-- Guided-journey onboarding: sticky per-shop milestone completions.
-- Rows are derived from existing data by app/lib/onboarding/journey.server.ts
-- and only ever INSERTED — deleting the underlying record later never
-- un-completes a step. Also holds UI marker rows (…_dismissed).
create table if not exists shop_setup_progress (
  shop_id uuid not null references shops(id) on delete cascade,
  milestone_key text not null,
  completed_at timestamptz not null default now(),
  primary key (shop_id, milestone_key)
);

alter table shop_setup_progress enable row level security;
-- Service-role only (same posture as assistant_* tables): no anon/authenticated
-- policies on purpose.
revoke all on table public.shop_setup_progress from anon, authenticated;
```

- [ ] **Step 2: Apply to prod**

Apply via the supabase MCP (`apply_migration`, project `ajgrmnvzxfxxlwrxcgnu`, name `shop_setup_progress`) — this repo tests on prod pre-launch. Verify: `select * from shop_setup_progress limit 1;` returns zero rows, no error.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260713090000_shop_setup_progress.sql
git commit -m "db: shop_setup_progress table for guided-journey milestones"
```

---

### Task 5: Journey model (client-safe, pure)

**Files:**
- Create: `app/lib/dashboard/journey-model.ts`
- Create: `app/lib/dashboard/journey-model.test.ts`

**Interfaces (later tasks depend on these exact names):**

```ts
export type MilestoneKey =
  | "account" | "first_product" | "payouts"
  | "shipping" | "storefront_published" | "test_order"
  | "autopilot_on" | "ask_calderyn" | "first_order";
export type JourneyPhase = 1 | 2 | 3;
export interface JourneyStepDef {
  key: MilestoneKey; phase: JourneyPhase; label: string; pitch: string; cta: string;
  // Screen id for app.navigate; "" = no CTA; special ids "__assistant" (open
  // panel) and "__test_order" (start test checkout) are handled by the card.
  screen: string;
}
export const JOURNEY_STEPS: JourneyStepDef[];
export const PHASE_TITLES: Record<JourneyPhase, string>; // 1: "Foundation", 2: "Launch", 3: "First wins"
export interface JourneyStepState { def: JourneyStepDef; done: boolean; completedAt: string | null }
export interface JourneyView {
  phase: JourneyPhase; retired: boolean; next: MilestoneKey | null;
  steps: JourneyStepState[];          // all 9, in order
  phasesComplete: JourneyPhase[];
  showRecap: boolean;                 // retired, not dismissed, and NOT backfilled
  showLiveCard: boolean;              // published, not dismissed, not retired, not backfilled
}
export function journeyView(input: {
  completed: Partial<Record<MilestoneKey, string>>; // key -> completed_at ISO
  liveCardDismissed: boolean;
  recapDismissed: boolean;
}): JourneyView;
export function journeyToastText(doneKey: MilestoneKey, next: MilestoneKey | null): string;
```

- [ ] **Step 1: Write the failing tests**

`app/lib/dashboard/journey-model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { journeyView, journeyToastText, JOURNEY_STEPS } from "./journey-model";

const T0 = "2026-07-13T00:00:00.000Z";
const LATER = "2026-07-20T00:00:00.000Z";

describe("journeyView", () => {
  it("defines exactly 9 steps, 3 per phase", () => {
    expect(JOURNEY_STEPS).toHaveLength(9);
    for (const p of [1, 2, 3]) {
      expect(JOURNEY_STEPS.filter((s) => s.phase === p)).toHaveLength(3);
    }
  });

  it("fresh store: phase 1, next = first_product, account pre-done", () => {
    const v = journeyView({ completed: { account: T0 }, liveCardDismissed: false, recapDismissed: false });
    expect(v.phase).toBe(1);
    expect(v.next).toBe("first_product");
    expect(v.retired).toBe(false);
  });

  it("phase advances when all its steps complete; next is first incomplete in order", () => {
    const v = journeyView({
      completed: { account: T0, first_product: T0, payouts: T0, shipping: LATER },
      liveCardDismissed: false, recapDismissed: false,
    });
    expect(v.phase).toBe(2);
    expect(v.phasesComplete).toEqual([1]);
    expect(v.next).toBe("storefront_published");
  });

  it("retires when first_order completes", () => {
    const all = Object.fromEntries(JOURNEY_STEPS.map((s) => [s.key, T0]));
    const v = journeyView({
      completed: { ...all, first_order: LATER },
      liveCardDismissed: false, recapDismissed: false,
    });
    expect(v.retired).toBe(true);
    expect(v.showRecap).toBe(true);
  });

  it("backfilled shops (everything stamped in one recompute) retire silently", () => {
    const all = Object.fromEntries(JOURNEY_STEPS.map((s) => [s.key, T0]));
    const v = journeyView({ completed: all, liveCardDismissed: false, recapDismissed: false });
    expect(v.retired).toBe(true);
    expect(v.showRecap).toBe(false);
    expect(v.showLiveCard).toBe(false);
  });

  it("live card shows after a real (non-backfilled) publish until dismissed or retired", () => {
    const v = journeyView({
      completed: { account: T0, first_product: T0, payouts: T0, shipping: T0, storefront_published: LATER },
      liveCardDismissed: false, recapDismissed: false,
    });
    expect(v.showLiveCard).toBe(true);
    const dismissed = journeyView({
      completed: { account: T0, storefront_published: LATER },
      liveCardDismissed: true, recapDismissed: false,
    });
    expect(dismissed.showLiveCard).toBe(false);
  });
});

describe("journeyToastText", () => {
  it("names the done step and the next one", () => {
    expect(journeyToastText("payouts", "shipping")).toBe(
      "Payouts connected — next: set up shipping",
    );
  });
  it("celebrates plainly when nothing is next", () => {
    expect(journeyToastText("first_order", null)).toBe("First order — setup complete.");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/lib/dashboard/journey-model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`app/lib/dashboard/journey-model.ts`:

```ts
export type MilestoneKey =
  | "account" | "first_product" | "payouts"
  | "shipping" | "storefront_published" | "test_order"
  | "autopilot_on" | "ask_calderyn" | "first_order";

export type JourneyPhase = 1 | 2 | 3;

export interface JourneyStepDef {
  key: MilestoneKey; phase: JourneyPhase; label: string; pitch: string; cta: string; screen: string;
}

export const PHASE_TITLES: Record<JourneyPhase, string> = {
  1: "Foundation", 2: "Launch", 3: "First wins",
};

export const JOURNEY_STEPS: JourneyStepDef[] = [
  { key: "account", phase: 1, label: "Create your account", pitch: "", cta: "", screen: "" },
  { key: "first_product", phase: 1, label: "Add your first product",
    pitch: "One sentence — Calderyn drafts the listing. Or import your Shopify catalog.",
    cta: "Create", screen: "product-editor" },
  { key: "payouts", phase: 1, label: "Connect payouts",
    pitch: "Stripe, about two minutes.", cta: "Connect", screen: "payments" },
  { key: "shipping", phase: 2, label: "Set up shipping",
    pitch: "Where you ship from, and one rate.", cta: "Set up", screen: "shipping" },
  { key: "storefront_published", phase: 2, label: "Publish your storefront",
    pitch: "Describe your brand — go live when it looks right.", cta: "Open", screen: "storefront" },
  { key: "test_order", phase: 2, label: "Place a test order",
    pitch: "A 50¢ run through your own checkout, refunded automatically.",
    cta: "Run test", screen: "__test_order" },
  { key: "autopilot_on", phase: 3, label: "Turn on Autopilot",
    pitch: "It watches inventory, pricing and ads — you approve the moves.",
    cta: "Turn on", screen: "autopilot" },
  { key: "ask_calderyn", phase: 3, label: "Ask Calderyn anything",
    pitch: "Try: “what should I fix first?”", cta: "Ask", screen: "__assistant" },
  { key: "first_order", phase: 3, label: "First real order",
    pitch: "This one completes itself.", cta: "", screen: "" },
];

// Toast fragments per completed step ("<done> — next: <verb next>").
const DONE_LABELS: Record<MilestoneKey, string> = {
  account: "Account created",
  first_product: "First product added",
  payouts: "Payouts connected",
  shipping: "Shipping set up",
  storefront_published: "Storefront live",
  test_order: "Test order placed",
  autopilot_on: "Autopilot on",
  ask_calderyn: "Assistant unlocked",
  first_order: "First order",
};
const NEXT_LABELS: Record<MilestoneKey, string> = {
  account: "create your account",
  first_product: "add your first product",
  payouts: "connect payouts",
  shipping: "set up shipping",
  storefront_published: "publish your storefront",
  test_order: "place a test order",
  autopilot_on: "turn on Autopilot",
  ask_calderyn: "ask Calderyn anything",
  first_order: "your first real order",
};

export interface JourneyStepState { def: JourneyStepDef; done: boolean; completedAt: string | null }

export interface JourneyView {
  phase: JourneyPhase; retired: boolean; next: MilestoneKey | null;
  steps: JourneyStepState[]; phasesComplete: JourneyPhase[];
  showRecap: boolean; showLiveCard: boolean;
}

// A shop whose entire history was stamped by one backfilling recompute never
// "did" the journey — suppress the celebration surfaces for it. 5 minutes
// comfortably exceeds one recompute pass while never misreading a real user,
// for whom consecutive steps are minutes-to-days apart.
const BACKFILL_WINDOW_MS = 5 * 60 * 1000;

function withinBackfill(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) < BACKFILL_WINDOW_MS;
}

export function journeyView(input: {
  completed: Partial<Record<MilestoneKey, string>>;
  liveCardDismissed: boolean;
  recapDismissed: boolean;
}): JourneyView {
  const { completed } = input;
  const steps: JourneyStepState[] = JOURNEY_STEPS.map((def) => ({
    def, done: completed[def.key] != null, completedAt: completed[def.key] ?? null,
  }));
  const phaseDone = (p: JourneyPhase) => steps.filter((s) => s.def.phase === p).every((s) => s.done);
  const phasesComplete = ([1, 2, 3] as JourneyPhase[]).filter(phaseDone);
  const phase: JourneyPhase = !phaseDone(1) ? 1 : !phaseDone(2) ? 2 : 3;
  const retired = completed.first_order != null;
  const next = steps.find((s) => s.def.phase === phase && !s.done)?.def.key ?? null;
  const backfilledRetire = withinBackfill(completed.first_order, completed.account);
  const backfilledPublish = withinBackfill(completed.storefront_published, completed.account);
  return {
    phase, retired, next, steps, phasesComplete,
    showRecap: retired && !input.recapDismissed && !backfilledRetire,
    showLiveCard:
      completed.storefront_published != null && !retired &&
      !input.liveCardDismissed && !backfilledPublish,
  };
}

export function journeyToastText(doneKey: MilestoneKey, next: MilestoneKey | null): string {
  if (!next) return `${DONE_LABELS[doneKey]} — setup complete.`;
  return `${DONE_LABELS[doneKey]} — next: ${NEXT_LABELS[next]}`;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run app/lib/dashboard/journey-model.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/lib/dashboard/journey-model.ts app/lib/dashboard/journey-model.test.ts
git commit -m "dashboard/journey: pure 3-phase journey model"
```

---

### Task 6: Journey server lib — signals, derivation, sticky recompute

**Files:**
- Create: `app/lib/onboarding/journey.server.ts`
- Create: `app/lib/onboarding/journey-derive.test.ts`
- Create: `app/lib/onboarding/journey-derive.ts` (pure derivation, testable without Supabase)

**Interfaces:**

```ts
// journey-derive.ts (pure)
export interface JourneySignals {
  productCount: number; payoutsReady: boolean; originSet: boolean; rateCount: number;
  storefrontPublished: boolean; testOrderCount: number; realOrderCount: number;
  autopilotEnabled: boolean; assistantConvoCount: number;
}
export function deriveDone(signals: JourneySignals): Set<MilestoneKey>;

// journey.server.ts
export async function recomputeJourney(shopId: string): Promise<void>;      // insert-only upsert of newly-derived keys
export interface JourneyProgress {
  completed: Partial<Record<MilestoneKey, string>>;
  liveCardDismissed: boolean; recapDismissed: boolean; storefrontUrl: string | null;
}
export async function getJourneyProgress(shopId: string): Promise<JourneyProgress>; // recompute + read
export async function dismissJourneyCard(shopId: string, key: "live_card_dismissed" | "recap_dismissed"): Promise<void>;
```

**Completion signals (verified table/column names):**

| Milestone | Signal |
|---|---|
| account | always true |
| first_product | `product_dim` count > 0 (`.eq("shop_id", …)`) |
| payouts | `stripe_connected_account`: `charges_enabled && payouts_enabled && details_submitted` (use `isFullyEnabledAccount` from `~/lib/payments/connect.server`) |
| shipping | `shop_origin` row exists AND (`ship_flat_rate` count > 0 OR `ship_carrier_service_registration` count > 0) |
| storefront_published | `page_document` row for `page_key = 'home'` with `published_json` not null |
| test_order | `orders` count with `channel = 'test'` and `state in ('paid','fulfilled','refunded','partially_refunded')` |
| first_order | `orders` count with `channel <> 'test'` (or channel null) and same sale states |
| autopilot_on | `guardrail_config.autopilot_enabled` true |
| ask_calderyn | `assistant_conversations` count > 0 |

- [ ] **Step 1: Write the failing derivation tests**

`app/lib/onboarding/journey-derive.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveDone } from "./journey-derive";

const NONE = {
  productCount: 0, payoutsReady: false, originSet: false, rateCount: 0,
  storefrontPublished: false, testOrderCount: 0, realOrderCount: 0,
  autopilotEnabled: false, assistantConvoCount: 0,
};

describe("deriveDone", () => {
  it("fresh shop: only account", () => {
    expect([...deriveDone(NONE)]).toEqual(["account"]);
  });
  it("shipping needs origin AND at least one rate", () => {
    expect(deriveDone({ ...NONE, originSet: true }).has("shipping")).toBe(false);
    expect(deriveDone({ ...NONE, rateCount: 1 }).has("shipping")).toBe(false);
    expect(deriveDone({ ...NONE, originSet: true, rateCount: 1 }).has("shipping")).toBe(true);
  });
  it("orders split into test and real", () => {
    const d = deriveDone({ ...NONE, testOrderCount: 1 });
    expect(d.has("test_order")).toBe(true);
    expect(d.has("first_order")).toBe(false);
    const r = deriveDone({ ...NONE, realOrderCount: 2 });
    expect(r.has("first_order")).toBe(true);
    expect(r.has("test_order")).toBe(false);
  });
  it("full shop: all nine", () => {
    const d = deriveDone({
      productCount: 3, payoutsReady: true, originSet: true, rateCount: 2,
      storefrontPublished: true, testOrderCount: 1, realOrderCount: 5,
      autopilotEnabled: true, assistantConvoCount: 4,
    });
    expect(d.size).toBe(9);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run app/lib/onboarding/journey-derive.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement the pure derivation**

`app/lib/onboarding/journey-derive.ts`:

```ts
import type { MilestoneKey } from "~/lib/dashboard/journey-model";

export interface JourneySignals {
  productCount: number; payoutsReady: boolean; originSet: boolean; rateCount: number;
  storefrontPublished: boolean; testOrderCount: number; realOrderCount: number;
  autopilotEnabled: boolean; assistantConvoCount: number;
}

export function deriveDone(s: JourneySignals): Set<MilestoneKey> {
  const done = new Set<MilestoneKey>(["account"]);
  if (s.productCount > 0) done.add("first_product");
  if (s.payoutsReady) done.add("payouts");
  if (s.originSet && s.rateCount > 0) done.add("shipping");
  if (s.storefrontPublished) done.add("storefront_published");
  if (s.testOrderCount > 0) done.add("test_order");
  if (s.realOrderCount > 0) done.add("first_order");
  if (s.autopilotEnabled) done.add("autopilot_on");
  if (s.assistantConvoCount > 0) done.add("ask_calderyn");
  return done;
}
```

Run the test — 4 passed. Commit (`git add app/lib/onboarding/journey-derive.*` … `"dashboard/journey: pure milestone derivation"`).

- [ ] **Step 4: Implement the server lib**

`app/lib/onboarding/journey.server.ts` — head-count queries batched with `Promise.all`; every one carries `.eq("shop_id", shopId)`; surface every Supabase error (throw, never swallow), except the recompute-write path which logs and continues (a failed materialization must not fail the read):

```ts
import { getSupabase } from "~/lib/supabase.server";
import { isFullyEnabledAccount } from "~/lib/payments/connect.server";
import { tenantDomain } from "~/lib/storefront/vercel-domain.server";
import type { MilestoneKey } from "~/lib/dashboard/journey-model";
import { deriveDone, type JourneySignals } from "./journey-derive";

const SALE_STATES = ["paid", "fulfilled", "refunded", "partially_refunded"];
const MARKER_KEYS = ["live_card_dismissed", "recap_dismissed"] as const;

async function readSignals(shopId: string): Promise<JourneySignals> {
  const sb = getSupabase();
  const count = (q: PromiseLike<{ count: number | null; error: unknown }>) =>
    q.then(({ count: c, error }) => {
      if (error) throw error;
      return c ?? 0;
    });
  const [products, stripeRow, published, origin, flatRates, carrier, testOrders, realOrders, guardrail, convos] =
    await Promise.all([
      count(sb.from("product_dim").select("id", { count: "exact", head: true }).eq("shop_id", shopId)),
      sb.from("stripe_connected_account").select("charges_enabled, payouts_enabled, details_submitted").eq("shop_id", shopId).maybeSingle(),
      sb.from("page_document").select("published_json").eq("shop_id", shopId).eq("page_key", "home").maybeSingle(),
      sb.from("shop_origin").select("shop_id").eq("shop_id", shopId).maybeSingle(),
      count(sb.from("ship_flat_rate").select("id", { count: "exact", head: true }).eq("shop_id", shopId)),
      count(sb.from("ship_carrier_service_registration").select("id", { count: "exact", head: true }).eq("shop_id", shopId)),
      count(sb.from("orders").select("id", { count: "exact", head: true }).eq("shop_id", shopId).eq("channel", "test").in("state", SALE_STATES)),
      count(sb.from("orders").select("id", { count: "exact", head: true }).eq("shop_id", shopId).neq("channel", "test").in("state", SALE_STATES)),
      sb.from("guardrail_config").select("autopilot_enabled").eq("shop_id", shopId).maybeSingle(),
      count(sb.from("assistant_conversations").select("id", { count: "exact", head: true }).eq("shop_id", shopId)),
    ]);
  for (const r of [stripeRow, published, origin, guardrail]) {
    if (r.error) throw r.error;
  }
  return {
    productCount: products,
    payoutsReady: stripeRow.data ? isFullyEnabledAccount(stripeRow.data) : false,
    originSet: origin.data != null,
    rateCount: flatRates + carrier,
    storefrontPublished: published.data?.published_json != null,
    testOrderCount: testOrders,
    realOrderCount: realOrders,
    autopilotEnabled: Boolean(guardrail.data?.autopilot_enabled),
    assistantConvoCount: convos,
  };
}

/** Insert-only materialization: stamps newly-derived milestones, never deletes.
 *  Failures log and return — a broken write must not break the Home read. */
export async function recomputeJourney(shopId: string): Promise<void> {
  try {
    const sb = getSupabase();
    const [signals, existing] = await Promise.all([
      readSignals(shopId),
      sb.from("shop_setup_progress").select("milestone_key").eq("shop_id", shopId),
    ]);
    if (existing.error) throw existing.error;
    const have = new Set((existing.data ?? []).map((r) => r.milestone_key as string));
    const missing = [...deriveDone(signals)].filter((k) => !have.has(k));
    if (!missing.length) return;
    const { error } = await sb
      .from("shop_setup_progress")
      .upsert(missing.map((k) => ({ shop_id: shopId, milestone_key: k })), { onConflict: "shop_id,milestone_key", ignoreDuplicates: true });
    if (error) throw error;
  } catch (err) {
    console.error("[journey] recompute failed", { shopId, err });
  }
}

export interface JourneyProgress {
  completed: Partial<Record<MilestoneKey, string>>;
  liveCardDismissed: boolean;
  recapDismissed: boolean;
  storefrontUrl: string | null;
}

export async function getJourneyProgress(shopId: string): Promise<JourneyProgress> {
  await recomputeJourney(shopId);
  const sb = getSupabase();
  const [{ data, error }, slugRow] = await Promise.all([
    sb.from("shop_setup_progress").select("milestone_key, completed_at").eq("shop_id", shopId),
    sb.from("shops").select("org_slug").eq("id", shopId).maybeSingle(),
  ]);
  if (error) throw error;
  const completed: Partial<Record<MilestoneKey, string>> = {};
  let liveCardDismissed = false;
  let recapDismissed = false;
  for (const row of data ?? []) {
    if (row.milestone_key === "live_card_dismissed") liveCardDismissed = true;
    else if (row.milestone_key === "recap_dismissed") recapDismissed = true;
    else completed[row.milestone_key as MilestoneKey] = row.completed_at as string;
  }
  const orgSlug = typeof slugRow?.data?.org_slug === "string" ? slugRow.data.org_slug : null;
  const storefrontUrl =
    orgSlug && process.env.NODE_ENV !== "development"
      ? `https://${tenantDomain(orgSlug)}/storefront`
      : "/storefront";
  return { completed, liveCardDismissed, recapDismissed, storefrontUrl };
}

export async function dismissJourneyCard(
  shopId: string,
  key: (typeof MARKER_KEYS)[number],
): Promise<void> {
  const { error } = await getSupabase()
    .from("shop_setup_progress")
    .upsert([{ shop_id: shopId, milestone_key: key }], { onConflict: "shop_id,milestone_key", ignoreDuplicates: true });
  if (error) throw error;
}
```

(Adjust the `slugRow` destructure to match TS — `slugRow` is the full response; read `slugRow.data?.org_slug`. Non-UUID demo shop ids: `shops.id` lookup simply returns null, same fail-soft as `shopOrgSlug` in `studio.server.ts:311-323`.)

- [ ] **Step 5: Typecheck + commit**

`npm run typecheck` → 0. Commit: `"dashboard/journey: server signals + sticky recompute"`.

---

### Task 7: API route + screen cache

**Files:**
- Create: `app/routes/dashboard.api.setup-progress._index.tsx`
- Modify: `app/lib/dashboard/screen-cache.ts` (add key `setupProgress: "setup-progress"` to `SCREEN_CACHE_KEYS`, lines 70–99)
- Modify: `app/lib/dashboard/prefetch.ts` (add `WARM_TARGETS` entry)

**Interfaces:**
- Produces: `GET /dashboard/api/setup-progress` → `JourneyPayload = JourneyProgress` (Task 6 shape, JSON). `POST` with `{ intent: "dismiss_live_card" | "dismiss_recap" }` → `{ ok: true }`.
- Cache key `SCREEN_CACHE_KEYS.setupProgress`.

- [ ] **Step 1: Implement the route**

Follow `dashboard.api.calibration._index.tsx` exactly:

```tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, requireSameOrigin, parseJsonObjectBody } from "~/lib/dashboard/http.server";
import { getJourneyProgress, dismissJourneyCard } from "~/lib/onboarding/journey.server";

// Loader note: getJourneyProgress materializes derived milestone rows
// (insert-only, idempotent). This is lazy cache-fill of derived state, not a
// user-data mutation — the documented exception to loaders-read-only.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => getJourneyProgress(session.shopId));
}

export async function action({ request }: ActionFunctionArgs) {
  const session = await requireDashboardSession(request);
  requireSameOrigin(request);
  return dashboardJson(async () => {
    const body = await parseJsonObjectBody(request);
    const intent = body.intent;
    if (intent !== "dismiss_live_card" && intent !== "dismiss_recap") {
      throw new Error("unknown intent");
    }
    await dismissJourneyCard(
      session.shopId,
      intent === "dismiss_live_card" ? "live_card_dismissed" : "recap_dismissed",
    );
    return { ok: true };
  });
}
```

(If `http.server.ts` exposes a typed error helper — `CalderynError` — use it for the unknown-intent 400 instead of a bare Error; copy whatever the nearest existing action does, e.g. any `dashboard.api.*` with intents.)

- [ ] **Step 2: Wire the cache**

`screen-cache.ts`: add `setupProgress: "setup-progress",` to `SCREEN_CACHE_KEYS`.
`prefetch.ts`: add to `WARM_TARGETS` (near the top — Home renders it):

```ts
[SCREEN_CACHE_KEYS.setupProgress, () => apiGet("/dashboard/api/setup-progress")],
```

(match the exact `apiGet` fetcher idiom used by the `agentic` entry at line ~54).

- [ ] **Step 3: Verify + commit**

`npm run typecheck` → 0. Local dev: `curl -s localhost:3000/dashboard/api/setup-progress -H "Cookie: <session>"` (or just hit it from the browser devtools while signed in) returns `{ completed: { account: … }, … }` and a `shop_setup_progress` row now exists for the shop. Commit: `"dashboard/api: setup-progress journey endpoint + cache wiring"`.

---

### Task 8: Home journey card (replaces the static checklist)

**Files:**
- Create: `app/components/dashboard/screens/HomeJourney.tsx`
- Modify: `app/components/dashboard/screens/Dashboard.tsx` (remove the inline setup card block at ~470–587 and the `setupSteps`/`setupDone`/`showSetup` computations at ~134–175; render `<HomeJourney …/>` in the same slot)
- Modify: `app/styles/dashboard.css` (append `cd-jr-*` rules)
- Modify: `app/components/dashboard/screens/__tests__/dashboard-setup-checklist.test.ts` (retire/replace — its pure logic moves to journey-model, already tested in Task 5)

**Interfaces:**
- Consumes: `journeyView`, `JOURNEY_STEPS`, `PHASE_TITLES` (Task 5); payload shape (Task 7); `app.navigate`, `app.openAssistant`, `app.toast` from `DashboardCtx`.
- Produces: `<HomeJourney data={JourneyProgress} onDismiss={(key) => void} onStartTestOrder={() => void} />`.

- [ ] **Step 1: Component**

`HomeJourney.tsx` — structure (uses `Card`, `Btn`, `CDIcon`; GSAP via `useGSAP` like `ui.tsx` does):

```tsx
import { useMemo, useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { Card, Btn } from "../ui";
import { CDIcon } from "../icons";
import { useDashboard } from "../context";
import { journeyView, PHASE_TITLES, type MilestoneKey } from "~/lib/dashboard/journey-model";
import type { JourneyProgress } from "~/lib/onboarding/journey.server";

export function HomeJourney({
  data, onDismiss, onStartTestOrder,
}: {
  data: JourneyProgress;
  onDismiss: (key: "dismiss_live_card" | "dismiss_recap") => void;
  onStartTestOrder: () => void;
}) {
  const app = useDashboard();
  const view = useMemo(() => journeyView(data), [data]);
  const rootRef = useRef<HTMLDivElement>(null);
  const doneCount = view.steps.filter((s) => s.done).length;

  useGSAP(() => {
    // Pop the most recent check; slide phase rows in on phase change.
    gsap.from(".cd-jr-row.done .cd-jr-check", { scale: 0.5, opacity: 0, duration: 0.3, ease: "back.out(2)", stagger: 0 });
  }, { scope: rootRef, dependencies: [doneCount, view.phase] });

  const go = (key: MilestoneKey, screen: string) => {
    if (screen === "__assistant") app.openAssistant("What should I fix first?");
    else if (screen === "__test_order") onStartTestOrder();
    else if (screen === "product-editor") app.navigate("product-editor", "new");
    else if (screen) app.navigate(screen as Parameters<typeof app.navigate>[0]);
  };

  if (view.retired) {
    if (!view.showRecap) return null;
    /* recap card: "Setup complete." + days + storefront link + Dismiss
       (onDismiss("dismiss_recap")) — full JSX in the "Recap JSX" block below */
  }

  const phaseSteps = view.steps.filter((s) => s.def.phase === view.phase);
  return (
    <div ref={rootRef}>
      {view.showLiveCard && (
        <Card className="cd-jr-live">
          <div className="cd-jr-live-t">Your store is live.</div>
          {data.storefrontUrl && (
            <div className="cd-jr-live-url">
              <a href={data.storefrontUrl} target="_blank" rel="noreferrer">{data.storefrontUrl}</a>
              <Btn small onClick={() => navigator.clipboard.writeText(data.storefrontUrl!)}>Copy link</Btn>
            </div>
          )}
          <button type="button" className="cd-jr-x" aria-label="Dismiss" onClick={() => onDismiss("dismiss_live_card")}>
            <CDIcon name="x" size={14} />
          </button>
        </Card>
      )}
      <Card className="cd-jr-card" pad={false}>
        <div className="cd-jr-head">
          <span className="cd-jr-title">{PHASE_TITLES[view.phase]}</span>
          {view.phasesComplete.map((p) => (
            <span key={p} className="cd-jr-chip"><CDIcon name="check" size={12} /> {PHASE_TITLES[p]}</span>
          ))}
          <span className="cd-caption tabular-nums">
            {phaseSteps.filter((s) => s.done).length} of {phaseSteps.length}
          </span>
        </div>
        {phaseSteps.map((s) => {
          const spotlight = s.def.key === view.next;
          return (
            <div key={s.def.key} className={`cd-jr-row${s.done ? " done" : ""}${spotlight ? " spot" : ""}`}>
              <span className="cd-jr-check">
                <CDIcon name={s.done ? "check" : "circle"} size={16} strokeWidth={2} />
              </span>
              <div className="cd-jr-body">
                <div className="cd-jr-t">{s.def.label}</div>
                {spotlight && s.def.pitch && <div className="cd-jr-s">{s.def.pitch}</div>}
              </div>
              {spotlight && s.def.cta && (
                <Btn kind="primary" small onClick={() => go(s.def.key, s.def.screen)}>{s.def.cta}</Btn>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}
```

Recap JSX (inside the `view.retired && view.showRecap` branch):

```tsx
const started = data.completed.account ? new Date(data.completed.account) : null;
const finished = data.completed.first_order ? new Date(data.completed.first_order) : null;
const days = started && finished
  ? Math.max(1, Math.round((finished.getTime() - started.getTime()) / 86_400_000))
  : null;
return (
  <Card className="cd-jr-recap">
    <div className="cd-jr-live-t">Setup complete.</div>
    <p className="cd-caption">
      {days ? `From zero to first order in ${days} day${days === 1 ? "" : "s"}.` : "Store live and selling."}
      {data.storefrontUrl ? <> Live at <a href={data.storefrontUrl} target="_blank" rel="noreferrer">{data.storefrontUrl}</a>.</> : null}
    </p>
    <Btn small onClick={() => onDismiss("dismiss_recap")}>Done</Btn>
  </Card>
);
```

Icon check: `check`, `x`, `circle` must exist in `CD_ICONS` (`app/components/dashboard/icons.tsx`); add any missing one as a one-line lucide import per the registry rule.

- [ ] **Step 2: Dashboard.tsx integration**

- Delete the `setupSteps`/`setupDone`/`payoutsActive`-for-checklist/`showSetup` block (~134–175) and the inline setup `Card` (~470–587). Keep `freshStore` (greeting, dormancy, deck still use it).
- Add state seeded from cache + revalidate (Payments.tsx pattern, lines 49–66):

```tsx
const [journey, setJourney] = useState<JourneyProgress | null>(
  () => cachedScreenData<JourneyProgress>(SCREEN_CACHE_KEYS.setupProgress),
);
useEffect(() => {
  let alive = true;
  apiGet<JourneyProgress>("/dashboard/api/setup-progress").then((p) => {
    cacheScreenData(SCREEN_CACHE_KEYS.setupProgress, p);
    if (alive) setJourney(p);
  }).catch(() => {});
  return () => { alive = false; };
}, []);
```

(Use the same `apiGet` helper Dashboard.tsx / client.ts already uses for other fetches; error → keep last cached payload, never block Home.)
- Render in the old checklist slot: `{journey && <HomeJourney data={journey} onDismiss={dismissJourney} onStartTestOrder={startTestOrder} />}` where `dismissJourney` POSTs the intent then re-fetches into cache, and `startTestOrder` is wired in Task 10 (until then: `() => app.navigate("cutover")` placeholder is NOT acceptable — wire Task 10 before merging; tasks 8–10 land in one PR).
- Fallback while `journey === null` (first paint, empty cache): render nothing (the metrics/deck already fill Home; the card pops in on fetch).

- [ ] **Step 3: CSS**

Append to `dashboard.css`, reusing the `cd-su-*` rules (~search "cd-su-") as the visual baseline — same paddings, dividers, and type sizes, plus:

```css
.cd-jr-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 0.78em; opacity: 0.7; border: 1px solid var(--line); }
.cd-jr-row { /* copy .cd-su-row */ }
.cd-jr-row.spot { /* subtle raised background, e.g. color-mix accent 6% */ }
.cd-jr-row.done .cd-jr-t { opacity: 0.55; text-decoration: none; }
.cd-jr-live { position: relative; }
.cd-jr-live-url { display: flex; gap: 10px; align-items: center; }
.cd-jr-x { position: absolute; top: 10px; right: 10px; background: none; border: 0; cursor: pointer; color: inherit; opacity: 0.6; }
```

(Exact token names: copy from the neighboring `cd-su-*` block — do not invent variables.)

- [ ] **Step 4: Tests + manual verify**

- Update/retire `dashboard-setup-checklist.test.ts` (its subject no longer exists; the logic lives in `journey-model.test.ts`). Delete the file in the same commit and note it in the message.
- `npx vitest run app/components/dashboard app/lib/dashboard` — green.
- Manual: reset calderyn-test → Home shows Foundation 1/3 with "Add your first product" spotlighted; add a product → row checks off with the pop, spotlight moves to payouts; Peak & Pine (established, has orders) → no card at all (backfilled-retired).

- [ ] **Step 5: Commit**

```bash
git add app/components/dashboard/screens/HomeJourney.tsx app/components/dashboard/screens/Dashboard.tsx app/styles/dashboard.css
git rm app/components/dashboard/screens/__tests__/dashboard-setup-checklist.test.ts
git commit -m "dashboard/Home: 3-phase guided journey card replaces static checklist"
```

---

### Task 9: Completion toasts anywhere in the app

**Files:**
- Create: `app/lib/dashboard/journey-watcher.ts`
- Create: `app/lib/dashboard/journey-watcher.test.ts`
- Modify: `app/components/dashboard/view-models.ts:272-277` (Toast type: add `action`)
- Modify: `app/components/dashboard/ui.tsx:820+` (ToastHost renders the action button)
- Modify: `app/components/dashboard/DashboardApp.tsx` (extend `toast` callback ~483–486; add the watcher effect)

**Interfaces:**
- Produces: `diffNewlyDone(prev: Set<string> | null, current: string[]): string[]`
- `Toast` gains `action?: { label: string; run: () => void }`; `app.toast(text, icon?, tone?, action?)`.

- [ ] **Step 1: Failing test**

`app/lib/dashboard/journey-watcher.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { diffNewlyDone } from "./journey-watcher";

describe("diffNewlyDone", () => {
  it("returns nothing on the baseline payload", () => {
    expect(diffNewlyDone(null, ["account", "first_product"])).toEqual([]);
  });
  it("returns only keys that flipped to done", () => {
    expect(diffNewlyDone(new Set(["account"]), ["account", "payouts"])).toEqual(["payouts"]);
  });
  it("ignores removals (stickiness is server-side)", () => {
    expect(diffNewlyDone(new Set(["account", "payouts"]), ["account"])).toEqual([]);
  });
});
```

Run → FAIL (module not found).

- [ ] **Step 2: Implement**

`journey-watcher.ts`:

```ts
// First payload after mount is the baseline — completions that happened while
// the app was closed produce no toasts; only transitions observed live do.
export function diffNewlyDone(prev: Set<string> | null, current: string[]): string[] {
  if (!prev) return [];
  return current.filter((k) => !prev.has(k));
}
```

Run test → 3 passed.

- [ ] **Step 3: Toast action support**

`view-models.ts` Toast: add `action?: { label: string; run: () => void };`.
`ToastHost` (`ui.tsx:820`): inside each `.cd-toast`, after the text, render:

```tsx
{t.action && (
  <button type="button" className="cd-toast-act" onClick={t.action.run}>
    {t.action.label}
  </button>
)}
```

CSS: `.cd-toast-act { margin-left: 10px; background: none; border: 0; color: var(--accent); cursor: pointer; font: inherit; }` (token per neighbors).
`DashboardApp.tsx` `toast` callback: append optional `action` param and pass it through to the Toast object.

- [ ] **Step 4: The watcher effect (DashboardApp)**

Add near the other nav-reactive effects. On every `nav.screen` change while the journey is unfinished, refetch progress (≥5s apart), diff, toast:

```tsx
const journeySeen = useRef<Set<string> | null>(null);
const journeyLastFetch = useRef(0);
useEffect(() => {
  const cached = cachedScreenData<JourneyProgress>(SCREEN_CACHE_KEYS.setupProgress);
  if (cached?.completed?.first_order) return; // retired: stop watching
  const now = Date.now();
  if (now - journeyLastFetch.current < 5000) return;
  journeyLastFetch.current = now;
  apiGet<JourneyProgress>("/dashboard/api/setup-progress").then((p) => {
    cacheScreenData(SCREEN_CACHE_KEYS.setupProgress, p);
    const keys = Object.keys(p.completed);
    const fresh = diffNewlyDone(journeySeen.current, keys);
    journeySeen.current = new Set(keys);
    if (!fresh.length) return;
    const view = journeyView({ completed: p.completed, liveCardDismissed: p.liveCardDismissed, recapDismissed: p.recapDismissed });
    for (const key of fresh) {
      const nextDef = JOURNEY_STEPS.find((s) => s.def?.key === view.next) /* adjust: find in JOURNEY_STEPS by key */;
      toast(
        journeyToastText(key as MilestoneKey, view.next),
        "check",
        undefined,
        view.next && nextDef?.screen && !nextDef.screen.startsWith("__")
          ? { label: "Go", run: () => navigate(nextDef.screen as never) }
          : undefined,
      );
    }
  }).catch(() => {});
}, [nav.screen]);
```

(Tidy the `nextDef` lookup: `JOURNEY_STEPS.find((s) => s.key === view.next)`. One toast per fresh key; in practice fresh.length is 1.)

- [ ] **Step 5: Verify + commit**

`npx vitest run app/lib/dashboard` green; typecheck 0. Manual: on calderyn-test, connect payouts on the Payments screen, then click any other tab → toast "Payouts connected — next: set up shipping" with a working "Go". Commit: `"dashboard: journey completion toasts with next-step action"`.

---

### Task 10: Test-order flow (start + confirm + auto-refund)

**Files:**
- Modify: `app/lib/cutover/test-transaction.server.ts` (extract probe core; add journey variant)
- Create: `app/routes/dashboard.api.journey-test-order._index.tsx`
- Modify: `app/components/dashboard/screens/Dashboard.tsx` (wire `startTestOrder`; handle `?test_order=` return param)

**Interfaces:**
- Produces: `startJourneyTestOrder(shopId: string, returnOrigin: string): Promise<{ url: string }>` (exported from test-transaction.server.ts)
- `POST /dashboard/api/journey-test-order` intents: `start` → `{ url }`; `confirm` → `{ confirmed: boolean }`.

- [ ] **Step 1: Extract the probe core**

In `test-transaction.server.ts`, factor the body of `startTestTransaction` after its two gates (lines ~50–90: guest-buyer upsert → order insert with `channel:"test"` → `createCommerceCheckoutSession`) into:

```ts
async function createTestProbeCheckout(
  shopId: string,
  readiness: Awaited<ReturnType<typeof paymentsReadiness>>,
  returnUrls: { success: string; cancel: string },
): Promise<{ url: string }> {
  /* moved body; returnUrls passed straight into createCommerceCheckoutSession */
}
```

`startTestTransaction` keeps its `dual_run` + readiness gates and calls the core with the existing go-live URLs. Add:

```ts
/** Journey "place a test order": same 50c probe as the go-live gate, but for
 *  native shops — no org-mode requirement. Refunded on confirm (journey API). */
export async function startJourneyTestOrder(shopId: string, returnOrigin: string): Promise<{ url: string }> {
  const readiness = await paymentsReadiness(shopId);
  if (!readiness.ready) {
    throw new Error("Connect Stripe (charges and payouts enabled) before running a test order.");
  }
  const home = `${returnOrigin}/dashboard`;
  return createTestProbeCheckout(shopId, readiness, {
    success: `${home}?test_order=success`,
    cancel: `${home}?test_order=cancelled`,
  });
}
```

Existing cutover behavior unchanged — run `npx vitest run app/lib/cutover` if tests exist there; typecheck must stay green.

- [ ] **Step 2: The API route**

`dashboard.api.journey-test-order._index.tsx` (action-only):

```tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, requireSameOrigin, parseJsonObjectBody } from "~/lib/dashboard/http.server";
import { startJourneyTestOrder, refundTestOrders } from "~/lib/cutover/test-transaction.server";
import { recomputeJourney } from "~/lib/onboarding/journey.server";
import { getSupabase } from "~/lib/supabase.server";

export async function action({ request }: ActionFunctionArgs) {
  const session = await requireDashboardSession(request);
  const origin = requireSameOrigin(request);
  return dashboardJson(async () => {
    const body = await parseJsonObjectBody(request);
    if (body.intent === "start") {
      return startJourneyTestOrder(session.shopId, origin);
    }
    if (body.intent === "confirm") {
      // Paid probe? Stamp the milestone, then refund the 50c (non-blocking).
      const { count, error } = await getSupabase()
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", session.shopId).eq("channel", "test")
        .in("state", ["paid", "fulfilled", "refunded", "partially_refunded"]);
      if (error) throw error;
      const confirmed = (count ?? 0) > 0;
      if (confirmed) {
        await recomputeJourney(session.shopId);
        await refundTestOrders(session.shopId, getSupabase()); // logs + swallows per its contract
      }
      return { confirmed };
    }
    throw new Error("unknown intent");
  });
}
```

(Check `requireSameOrigin`'s actual return — cutover's caller (`startTestTransaction` call site) shows the idiom for obtaining the validated origin; copy it. Only refund when the shop is NOT in cutover dual_run — guard with `getOrgMode(shopId) !== "dual_run"` so the go-live gate's own probe accounting is never disturbed; import from `~/lib/cutover/org-mode.server`.)

- [ ] **Step 3: Wire the Home side**

In `Dashboard.tsx`:

```tsx
const startTestOrder = useCallback(() => {
  apiPost<{ url: string }>("/dashboard/api/journey-test-order", { intent: "start" })
    .then(({ url }) => { window.location.href = url; })
    .catch((e) => app.toast(e instanceof Error ? e.message : "Couldn't start the test order.", undefined, "critical"));
}, [app]);

useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  const marker = params.get("test_order");
  if (!marker) return;
  params.delete("test_order");
  const qs = params.toString();
  window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
  if (marker === "success") {
    apiPost<{ confirmed: boolean }>("/dashboard/api/journey-test-order", { intent: "confirm" })
      .then(({ confirmed }) => {
        if (confirmed) refetchJourney(); // the Task 8 revalidate helper
      })
      .catch(() => {});
  }
}, []);
```

(`apiPost` = the same-origin JSON POST helper the other screens use — find it in `app/lib/dashboard/client.ts`; match its name exactly. Pass `startTestOrder` into `<HomeJourney onStartTestOrder={…}/>`.)

- [ ] **Step 4: Verify + commit**

Typecheck + lint + build green. Manual (demo shop has Stripe ready): journey card phase 2 → "Run test" → Stripe checkout (50¢) → complete with test card if the account is a test-mode account, else cancel and verify the cancel path returns cleanly with no milestone stamped. On success return: milestone checks off, refund issued (verify in Stripe dashboard / orders list shows refunded probe). Commit: `"dashboard/journey: place-a-test-order flow with auto-refund"`.

---

### Task 11: Final gate, PR, spec progress report

- [ ] **Step 1: Full pre-commit gate on `feat/onboarding-journey`**

In order, paste results: `/code-review` (resolve blockers) → `git diff --check` → `npm run typecheck` → `npm run lint` → `npm run build` → `npx vitest run` (whole suite).

- [ ] **Step 2: End-to-end run-through**

Reset calderyn-test onboarding; walk all 9 steps in one sitting (product → payouts (Stripe test) → shipping → publish → test order → autopilot on → ask assistant → simulate first order via demo tooling). Verify: card morphs between phases, every completion toasts exactly once, "You're live" card appears on publish and dismisses, recap appears after first order, and a second visit shows no card.

- [ ] **Step 3: Push + PR**

Push `feat/onboarding-journey`, open PR against main titled `dashboard: guided journey onboarding (3 phases, toasts, live moment)`. Body: link the spec, list the three already-merged Part B PRs, and note the `NewProductFlow.tsx`/`dashboard.css` overlap with `feat/autopilot-agentic-redesign`. Do NOT merge without John's go (repo rule: auto-commit yes, auto-PR/merge no).

- [ ] **Step 4: Cleanup**

After merge + verify on prod: `git worktree remove ../calderyn-onboarding` and prune the fix branches.
