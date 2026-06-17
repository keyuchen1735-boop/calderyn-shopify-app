# Custom-settable Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every dashboard guardrail custom-settable (preset chips + a "Custom" reveal), make the business-hours window editable on both surfaces, expose the two autopilot scale-up caps, and unify guardrail validation behind one bounded validator.

**Architecture:** The backend (PUT `/dashboard/api/guardrails`, `calderynClient.guardrails.update`) already accepts arbitrary values. This change (a) expands the shared validator with upper bounds + business-hours-format + a new `business_hours_only` flag, (b) wires three already-persisted keys through the dashboard route's allow-list, (c) persists the business-hours window (currently dropped on write) with a tested local↔UTC hour conversion, and (d) replaces the dashboard's fixed preset controls with a reusable `GuardrailField` (presets + custom input) plus a `BusinessHoursEditor`, mirrored into the embedded Polaris admin.

**Tech Stack:** Remix + React 18, TypeScript (strict), Vitest (`react-dom/server` `renderToString` for component tests — no testing-library in this repo), Supabase (`guardrail_config` table), Polaris (embedded admin), bespoke dashboard UI (`app/components/dashboard/ui.tsx`, `.cd-*` classes in `app/styles/dashboard.css`).

## Global Constraints

- **TypeScript only**, strict; no `any` without written justification. `tsc --noEmit` is authoritative.
- **Dashboard icons** via `CDIcon` only; **embedded admin** uses `@shopify/polaris-icons`. (No new icons needed here.)
- **Keep the merchant screen simple** (spec non-goal): default view ≈ today's screen + a "Custom" option + one toggle. Advanced controls (scale-up caps) stay inside the autopilot block, which is off by default.
- **No DB migration** — every `guardrail_config` column already exists.
- **No change to the autopilot enforcement path** (`app/lib/actions/guardrails.server.ts`, `app/lib/actions/guardrails.ts`, `withinBusinessHours`).
- **Run tests via the project script:** `npm run test -- <file>` (a bare `npx vitest` picks up the wrong config and fails to load).
- **Validation ceilings (verbatim):** dollar fields ≤ `100_000_000` cents ($1,000,000); `cooldown_minutes` ≤ `10_080`; `business_hours` start/end match `^([01]\d|2[0-3]):00$`; `business_hours.tz` must be a valid IANA zone.
- **Dashboard route response contract is unchanged:** validation failure → `422 { error: "invalid_guardrails" }` (existing tests depend on this exact code).
- **Worktree:** all work happens in `../calderyn-custom-guardrails` (branch `feat/custom-guardrails`). It needs its own `npm install` (a fresh worktree has no `node_modules`) — see Task 0.
- **Pre-commit gate** (per `CLAUDE.md`, before the final merge): `/code-review` → `npm run typecheck` → `npm run lint` (`--max-warnings=0` on new code) → `npm run build` → `npm run test`, all green with output shown.

---

### Task 0: Worktree dependencies

**Files:** none (environment setup).

- [ ] **Step 1: Install dependencies in the worktree**

The worktree already exists (`../calderyn-custom-guardrails`, branch `feat/custom-guardrails`). A fresh worktree shares git history but not `node_modules`.

Run (from the worktree root):
```bash
npm install
```
Expected: install completes, `node_modules/` present.

- [ ] **Step 2: Confirm the baseline is green**

Run:
```bash
npm run test -- app/lib/dashboard/__tests__/guardrails-validation.test.ts app/lib/dashboard/__tests__/api-write-routes.test.ts
```
Expected: PASS (13 + 25 tests). This is the baseline these tasks must not regress.

---

### Task 1: Business-hours local↔UTC conversion helpers

`guardrail_config.business_hours_start_utc` / `business_hours_end_utc` are whole **UTC hours**. Merchants set wall-clock hours in their store timezone. These pure helpers convert both ways using the zone's offset at a reference instant (injectable for deterministic tests).

**Files:**
- Create: `app/lib/dashboard/business-hours.ts`
- Test: `app/lib/dashboard/__tests__/business-hours.test.ts`

**Interfaces:**
- Produces:
  - `tzOffsetHours(tz: string, ref: Date): number` — hours to ADD to a UTC hour to get the local wall-clock hour (e.g. `America/New_York` winter → `-5`).
  - `utcHourToLocal(utcHour: number, tz: string, ref?: Date): string` — returns `"HH:00"`.
  - `localHourToUtc(localHHmm: string, tz: string, ref?: Date): number` — returns `0…23`.

- [ ] **Step 1: Write the failing test**

Create `app/lib/dashboard/__tests__/business-hours.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { tzOffsetHours, utcHourToLocal, localHourToUtc } from "../business-hours";

// Fixed reference instants so the test is independent of the run date.
const WINTER = new Date("2025-01-15T12:00:00Z"); // America/New_York = EST (UTC-5)
const SUMMER = new Date("2025-07-15T12:00:00Z"); // America/New_York = EDT (UTC-4)

describe("tzOffsetHours", () => {
  it("is -5 for New York in winter and -4 in summer", () => {
    expect(tzOffsetHours("America/New_York", WINTER)).toBe(-5);
    expect(tzOffsetHours("America/New_York", SUMMER)).toBe(-4);
  });
  it("is 0 for UTC", () => {
    expect(tzOffsetHours("UTC", WINTER)).toBe(0);
  });
});

describe("utcHourToLocal", () => {
  it("renders the stored UTC hour as local wall-clock (winter)", () => {
    expect(utcHourToLocal(14, "America/New_York", WINTER)).toBe("09:00");
    expect(utcHourToLocal(0, "America/New_York", WINTER)).toBe("19:00");
  });
  it("shifts by one hour across DST (summer)", () => {
    expect(utcHourToLocal(14, "America/New_York", SUMMER)).toBe("10:00");
  });
});

describe("localHourToUtc", () => {
  it("is the inverse of utcHourToLocal (winter)", () => {
    expect(localHourToUtc("09:00", "America/New_York", WINTER)).toBe(14);
    expect(localHourToUtc("19:00", "America/New_York", WINTER)).toBe(0);
  });
  it("round-trips for every whole hour in a whole-hour zone", () => {
    for (let h = 0; h < 24; h++) {
      const local = utcHourToLocal(h, "America/New_York", WINTER);
      expect(localHourToUtc(local, "America/New_York", WINTER)).toBe(h);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- app/lib/dashboard/__tests__/business-hours.test.ts`
Expected: FAIL (`Failed to resolve import "../business-hours"`).

- [ ] **Step 3: Write the implementation**

Create `app/lib/dashboard/business-hours.ts`:
```ts
// Pure local↔UTC whole-hour conversion for the business-hours window.
// guardrail_config stores the window as integer UTC hours; merchants edit
// wall-clock hours in their store timezone. The conversion uses the zone's
// offset at `ref` (defaults to now). NOTE: a single integer UTC hour cannot
// track DST, so an enforced window can drift +/-1h for ~half the year; this is
// an accepted limitation of the existing schema. Half-hour zones (e.g. India)
// are rounded to the nearest whole hour for the same reason.

/** Hours to ADD to a UTC hour to get the local wall-clock hour for `tz` at `ref`. */
export function tzOffsetHours(tz: string, ref: Date): number {
  const hourIn = (timeZone: string) =>
    Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "2-digit",
        hourCycle: "h23",
      }).format(ref),
    );
  let diff = hourIn(tz) - hourIn("UTC");
  if (diff > 12) diff -= 24;
  if (diff < -12) diff += 24;
  return diff;
}

const wrap24 = (h: number) => ((Math.round(h) % 24) + 24) % 24;

export function utcHourToLocal(utcHour: number, tz: string, ref: Date = new Date()): string {
  const local = wrap24(utcHour + tzOffsetHours(tz, ref));
  return `${String(local).padStart(2, "0")}:00`;
}

export function localHourToUtc(localHHmm: string, tz: string, ref: Date = new Date()): number {
  const localHour = Number(String(localHHmm).slice(0, 2));
  return wrap24(localHour - tzOffsetHours(tz, ref));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- app/lib/dashboard/__tests__/business-hours.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add app/lib/dashboard/business-hours.ts app/lib/dashboard/__tests__/business-hours.test.ts
git commit -m "lib/dashboard: add local<->UTC business-hours conversion helpers"
```

---

### Task 2: Add `business_hours_only` to the guardrail contract

The validator (Task 3), server mappers (Task 5) and UI (Tasks 6–9) all reference `business_hours_only`. Add it to the contract first so everything else type-checks.

**Files:**
- Modify: `app/lib/types.ts` (the `GuardrailConfig` interface, ~lines 216–230)
- Modify: `app/components/dashboard/view-models.ts` (the `GuardrailVM` interface, ~lines 141–155)

**Interfaces:**
- Produces: `GuardrailConfig.business_hours_only: boolean` and `GuardrailVM.business_hours_only: boolean`.

- [ ] **Step 1: Add the field to `GuardrailConfig`**

In `app/lib/types.ts`, inside `interface GuardrailConfig`, add the field right after `in_business_hours: boolean;`:
```ts
  in_business_hours: boolean;
  /** When true, actions only execute inside business_hours; else the window is informational. */
  business_hours_only: boolean;
```

- [ ] **Step 2: Add the field to `GuardrailVM`**

In `app/components/dashboard/view-models.ts`, inside `interface GuardrailVM`, add after `in_business_hours: boolean;`:
```ts
  in_business_hours: boolean;
  business_hours_only: boolean;
```
(`toGuardrailVM` in `app/lib/dashboard/client.ts` spreads `...g`, so it carries the new field through automatically — no change needed there.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0. (It will still pass because every producer of `GuardrailConfig` is updated in Task 5; until then `rowToGuardrails` does not yet return the field, but TypeScript object-literal return checks will flag it — if `tsc` errors here pointing at `rowToGuardrails`, that is expected and fixed in Task 5. If you are running tasks in order, proceed; re-run typecheck at the end of Task 5.)

> NOTE for the implementer: Because adding a required field to `GuardrailConfig` makes `rowToGuardrails` (Task 5) temporarily non-conforming, do **not** commit Task 2 alone if your repo blocks on `tsc`. Either run Tasks 2 and 5 back-to-back and commit together, or make the field addition + Task 5 mapper edit in one commit. The step-5 commit below assumes you proceed to Task 5 next.

- [ ] **Step 4: Commit (with Task 5, or alone if `tsc` is green)**

```bash
git add app/lib/types.ts app/components/dashboard/view-models.ts
git commit -m "types: add business_hours_only to the guardrail contract"
```

---

### Task 3: Expand the shared validator

Move the budget/cap/cooldown checks out of the route into `validateGuardrailPatch`, add upper bounds, tighten `business_hours` to real format/zone checks, and validate `business_hours_only`. The autopilot-bound checks already exist and stay unchanged.

**Files:**
- Modify: `app/lib/dashboard/guardrails-validation.ts`
- Test: `app/lib/dashboard/__tests__/guardrails-validation.test.ts` (extend)

**Interfaces:**
- Consumes: `GuardrailConfig.business_hours_only` (Task 2).
- Produces: `validateGuardrailPatch(patch): string | null` now also covers `daily_action_budget_cents`, `dollar_cap_cents`, `cooldown_minutes`, `business_hours_only`, tighter `business_hours`, and upper bounds on `autopilot_min_spend_cents` / `autopilot_max_daily_budget_cents`.

- [ ] **Step 1: Write the failing tests (append to the existing describe block)**

In `app/lib/dashboard/__tests__/guardrails-validation.test.ts`, before the final `});` of `describe("validateGuardrailPatch", ...)`, add:
```ts
  it("validates budget/cap/cooldown (moved in from the route)", () => {
    expect(validateGuardrailPatch({ daily_action_budget_cents: 0 })).not.toBeNull();
    expect(validateGuardrailPatch({ dollar_cap_cents: -100 })).not.toBeNull();
    expect(validateGuardrailPatch({ daily_action_budget_cents: "lots" as unknown as number })).not.toBeNull();
    expect(validateGuardrailPatch({ cooldown_minutes: -5 })).not.toBeNull();
    expect(validateGuardrailPatch({ cooldown_minutes: 0 })).toBeNull();
    expect(validateGuardrailPatch({ daily_action_budget_cents: 75_000, dollar_cap_cents: 20_000 })).toBeNull();
  });

  it("rejects values above the sanity ceilings", () => {
    expect(validateGuardrailPatch({ daily_action_budget_cents: 100_000_001 })).not.toBeNull();
    expect(validateGuardrailPatch({ dollar_cap_cents: 100_000_001 })).not.toBeNull();
    expect(validateGuardrailPatch({ cooldown_minutes: 10_081 })).not.toBeNull();
    expect(validateGuardrailPatch({ autopilot_min_spend_cents: 100_000_001 })).not.toBeNull();
    expect(validateGuardrailPatch({ autopilot_max_daily_budget_cents: 100_000_001 })).not.toBeNull();
  });

  it("requires business_hours start/end to be whole HH:00 and a real timezone", () => {
    expect(validateGuardrailPatch({ business_hours: { start: "09:30", end: "17:00", tz: "America/New_York" } as never })).not.toBeNull();
    expect(validateGuardrailPatch({ business_hours: { start: "9:00", end: "17:00", tz: "America/New_York" } as never })).not.toBeNull();
    expect(validateGuardrailPatch({ business_hours: { start: "09:00", end: "17:00", tz: "Mars/Phobos" } as never })).not.toBeNull();
    expect(validateGuardrailPatch({ business_hours: { start: "09:00", end: "17:00", tz: "America/New_York" } as never })).toBeNull();
  });

  it("validates business_hours_only as a boolean", () => {
    expect(validateGuardrailPatch({ business_hours_only: true })).toBeNull();
    expect(validateGuardrailPatch({ business_hours_only: "yes" as unknown as boolean })).not.toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- app/lib/dashboard/__tests__/guardrails-validation.test.ts`
Expected: FAIL on the new cases (e.g. `daily_action_budget_cents: 0` currently returns null; `business_hours` with `"09:30"` currently returns null).

- [ ] **Step 3: Implement the expanded validator**

In `app/lib/dashboard/guardrails-validation.ts`, replace the body so it reads (keep the file header comment; update the budget/cap/cooldown note):

```ts
import type { GuardrailConfig } from "~/lib/types";

const isFiniteNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const MONEY_CAP_CENTS = 100_000_000; // $1,000,000 — fat-finger ceiling, not a product limit
const COOLDOWN_MAX_MIN = 10_080; // 1 week
const HHMM_WHOLE_HOUR = /^([01]\d|2[0-3]):00$/;

function isValidTimeZone(tz: unknown): boolean {
  if (typeof tz !== "string" || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns an error code string when the patch is invalid, or null when every
 * present key is in range. Only validates keys actually present (partial patch).
 */
export function validateGuardrailPatch(patch: Partial<GuardrailConfig>): string | null {
  if ("daily_action_budget_cents" in patch) {
    const v = patch.daily_action_budget_cents;
    if (!isFiniteNum(v) || v <= 0 || v > MONEY_CAP_CENTS) return "invalid_daily_action_budget_cents";
  }

  if ("dollar_cap_cents" in patch) {
    const v = patch.dollar_cap_cents;
    if (!isFiniteNum(v) || v <= 0 || v > MONEY_CAP_CENTS) return "invalid_dollar_cap_cents";
  }

  if ("cooldown_minutes" in patch) {
    const v = patch.cooldown_minutes;
    if (!isFiniteNum(v) || v < 0 || v > COOLDOWN_MAX_MIN) return "invalid_cooldown_minutes";
  }

  if ("autopilot_enabled" in patch && typeof patch.autopilot_enabled !== "boolean") {
    return "invalid_autopilot_enabled";
  }

  if ("autopilot_daily_action_cap" in patch) {
    const v = patch.autopilot_daily_action_cap;
    if (!isFiniteNum(v) || !Number.isInteger(v) || v < 0 || v > 100) {
      return "invalid_autopilot_daily_action_cap";
    }
  }

  if ("autopilot_min_spend_cents" in patch) {
    const v = patch.autopilot_min_spend_cents;
    if (!isFiniteNum(v) || v < 0 || v > MONEY_CAP_CENTS) return "invalid_autopilot_min_spend_cents";
  }

  if ("autopilot_max_budget_cut_pct" in patch) {
    const v = patch.autopilot_max_budget_cut_pct;
    if (!isFiniteNum(v) || v < 0 || v > 100) return "invalid_autopilot_max_budget_cut_pct";
  }

  if ("autopilot_max_budget_increase_pct" in patch) {
    const v = patch.autopilot_max_budget_increase_pct;
    if (!isFiniteNum(v) || v < 0 || v > 100) return "invalid_autopilot_max_budget_increase_pct";
  }

  if ("autopilot_max_daily_budget_cents" in patch) {
    const v = patch.autopilot_max_daily_budget_cents;
    // null = "no ceiling" is valid; otherwise a non-negative finite number within the cap.
    if (v !== null && (!isFiniteNum(v) || v < 0 || v > MONEY_CAP_CENTS)) {
      return "invalid_autopilot_max_daily_budget_cents";
    }
  }

  if ("business_hours_only" in patch && typeof patch.business_hours_only !== "boolean") {
    return "invalid_business_hours_only";
  }

  if ("business_hours" in patch) {
    const bh = patch.business_hours as unknown as Record<string, unknown> | null;
    const start = bh?.start;
    const end = bh?.end;
    if (
      typeof bh !== "object" ||
      bh === null ||
      typeof start !== "string" ||
      typeof end !== "string" ||
      !HHMM_WHOLE_HOUR.test(start) ||
      !HHMM_WHOLE_HOUR.test(end) ||
      !isValidTimeZone(bh.tz)
    ) {
      return "invalid_business_hours";
    }
  }

  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- app/lib/dashboard/__tests__/guardrails-validation.test.ts`
Expected: PASS (original 13 + the 4 new cases). The existing "accepts a well-formed business_hours object" case uses `"09:00"`/`"17:00"`/`"America/New_York"` and still passes.

- [ ] **Step 5: Commit**

```bash
git add app/lib/dashboard/guardrails-validation.ts app/lib/dashboard/__tests__/guardrails-validation.test.ts
git commit -m "lib/dashboard: consolidate + bound guardrail validation"
```

---

### Task 4: Dashboard route — allow-list + single validator

**Files:**
- Modify: `app/routes/dashboard.api.guardrails.tsx`
- Test: `app/lib/dashboard/__tests__/api-write-routes.test.ts` (extend the `PUT /dashboard/api/guardrails` describe block)

**Interfaces:**
- Consumes: `validateGuardrailPatch` (Task 3).
- Produces: route accepts `business_hours_only`, `autopilot_max_budget_increase_pct`, `autopilot_max_daily_budget_cents`; rejects out-of-range with `422 { error: "invalid_guardrails" }`.

- [ ] **Step 1: Write the failing tests**

In `app/lib/dashboard/__tests__/api-write-routes.test.ts`, inside `describe("PUT /dashboard/api/guardrails", ...)`, add:
```ts
  it("passes the new patchable keys through to update", async () => {
    guardrailsUpdate.mockResolvedValueOnce({});
    const patch = {
      business_hours_only: true,
      business_hours: { start: "09:00", end: "17:00", tz: "America/New_York" },
      autopilot_max_budget_increase_pct: 25,
      autopilot_max_daily_budget_cents: 50_000,
    };
    const res = (await guardrailsAction({
      request: post("https://calderyncompany.com/dashboard/api/guardrails", patch, "PUT"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(guardrailsUpdate).toHaveBeenCalledWith(patch);
  });

  it("422s on an out-of-range value above the sanity ceiling", async () => {
    const res = (await guardrailsAction({
      request: post(
        "https://calderyncompany.com/dashboard/api/guardrails",
        { daily_action_budget_cents: 100_000_001 },
        "PUT",
      ),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_guardrails");
    expect(guardrailsUpdate).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- app/lib/dashboard/__tests__/api-write-routes.test.ts`
Expected: FAIL — `business_hours_only` etc. are dropped from the patch (not in `PATCHABLE_KEYS`), so `update` is called with a smaller object; and the out-of-range budget currently passes the inline `positive` check.

- [ ] **Step 3: Edit the route**

In `app/routes/dashboard.api.guardrails.tsx`:

(a) Extend `PATCHABLE_KEYS`:
```ts
const PATCHABLE_KEYS: (keyof GuardrailConfig)[] = [
  "daily_action_budget_cents",
  "dollar_cap_cents",
  "cooldown_minutes",
  "business_hours",
  "business_hours_only",
  "autopilot_enabled",
  "autopilot_daily_action_cap",
  "autopilot_min_spend_cents",
  "autopilot_max_budget_cut_pct",
  "autopilot_max_budget_increase_pct",
  "autopilot_max_daily_budget_cents",
];
```

(b) Replace the inline positive/nonNegative checks + the trailing `validateGuardrailPatch` call (everything from `// Mirror the onboarding guard ...` down to the `if (validateGuardrailPatch(patch)) ...` line) with a single validation gate:
```ts
  if (Object.keys(patch).length === 0) return jsonError(422, "empty_patch");

  // Single source of truth for bounds (lib/dashboard/guardrails-validation.ts).
  // Response code stays generic for the web client; the specific code is internal.
  if (validateGuardrailPatch(patch) !== null) return jsonError(422, "invalid_guardrails");

  return dashboardJson(async () => ({
    guardrails: await calderynClient(session.shopDomain).guardrails.update(patch),
  }));
```
Delete the now-unused `positive`/`nonNegative` local helpers. Keep the existing `import { validateGuardrailPatch } ...`.

- [ ] **Step 4: Run to verify pass**

Run: `npm run test -- app/lib/dashboard/__tests__/api-write-routes.test.ts`
Expected: PASS — original 25 + 2 new. The existing `it.each([... zero budget / negative cap / non-numeric / negative cooldown ...])` cases still return `422 invalid_guardrails` because the validator now rejects them.

- [ ] **Step 5: Commit**

```bash
git add app/routes/dashboard.api.guardrails.tsx app/lib/dashboard/__tests__/api-write-routes.test.ts
git commit -m "routes/dashboard.api.guardrails: allow scale-up + business_hours_only, single validator"
```

---

### Task 5: Server mappers — read/write the business-hours window

`rowToGuardrails` currently returns the raw UTC hour mislabeled with the shop timezone and omits `business_hours_only`; `guardrails.update` drops the window start/end. Wire in the Task 1 helpers.

**Files:**
- Modify: `app/lib/calderyn.server.ts` — `rowToGuardrails` (~lines 218–244) and the `guardrails.update` mapper (~lines 1202–1242)

**Interfaces:**
- Consumes: `localHourToUtc`, `utcHourToLocal` (Task 1); `GuardrailConfig.business_hours_only` (Task 2).

- [ ] **Step 1: Add the import**

Near the top of `app/lib/calderyn.server.ts`, beside the existing `import { withinBusinessHours } from "./actions/guardrails";`, add:
```ts
import { localHourToUtc, utcHourToLocal } from "./dashboard/business-hours";
```

- [ ] **Step 2: Update `rowToGuardrails`**

Replace the `business_hours` block + add `business_hours_only`. The `start`/`end` become local wall-clock via `utcHourToLocal`; `in_business_hours` stays on the **raw UTC hours** (the enforcement path is unchanged):
```ts
  const tz = String(r.timezone ?? "America/New_York");
  const startUtc = Number(r.business_hours_start_utc ?? 14);
  const endUtc = Number(r.business_hours_end_utc ?? 0);
  return {
    daily_action_budget_cents: Number(r.daily_action_budget ?? 0) * 100,
    daily_action_budget_used_cents: usedCents,
    dollar_cap_cents: Math.round(Number(r.dollar_impact_cap_without_2fa ?? 0) * 100),
    cooldown_minutes: Number(r.cooldown_minutes_per_campaign ?? 30),
    business_hours: {
      start: utcHourToLocal(startUtc, tz),
      end: utcHourToLocal(endUtc, tz),
      tz,
    },
    business_hours_only: Boolean(r.business_hours_only),
    in_business_hours: withinBusinessHours(startUtc, endUtc, new Date().getUTCHours()),
    autopilot_enabled: Boolean(r.autopilot_enabled),
    autopilot_daily_action_cap: Number(r.autopilot_daily_action_cap ?? 3),
    autopilot_min_spend_cents: Number(r.autopilot_min_spend_cents ?? 20000),
    autopilot_max_budget_cut_pct: Number(r.autopilot_max_budget_cut_pct ?? 50),
    autopilot_max_budget_increase_pct: Number(r.autopilot_max_budget_increase_pct ?? 20),
    autopilot_max_daily_budget_cents:
      r.autopilot_max_daily_budget_cents == null ? null : Number(r.autopilot_max_daily_budget_cents),
  };
```
(Keep the explanatory comments already present on `in_business_hours`.)

- [ ] **Step 3: Update the `guardrails.update` mapper**

In the `update(patch, ...)` function, replace the single line
`if (patch.business_hours?.tz) updates.timezone = patch.business_hours.tz;`
with window + flag persistence:
```ts
          if (patch.business_hours) {
            const tz = patch.business_hours.tz;
            if (tz) updates.timezone = tz;
            const zone = tz ?? "America/New_York";
            updates.business_hours_start_utc = localHourToUtc(patch.business_hours.start, zone);
            updates.business_hours_end_utc = localHourToUtc(patch.business_hours.end, zone);
          }
          if (patch.business_hours_only !== undefined) {
            updates.business_hours_only = patch.business_hours_only;
          }
```
(The route guarantees `business_hours` carries a validated `{start, end, tz}` triple, so `start`/`end` are safe `"HH:00"` strings here.)

- [ ] **Step 4: Typecheck + run the full guardrails/route suite**

Run:
```bash
npm run typecheck
npm run test -- app/lib/dashboard/__tests__/business-hours.test.ts app/lib/dashboard/__tests__/guardrails-validation.test.ts app/lib/dashboard/__tests__/api-write-routes.test.ts app/lib/actions/__tests__/guardrails-server.test.ts
```
Expected: typecheck exit 0 (the `GuardrailConfig` object literals in `rowToGuardrails` now satisfy the Task-2 type); all listed test files PASS (the enforcement-path test `guardrails-server.test.ts` is unchanged and still green).

> Coverage note: `rowToGuardrails`/`update` are thin glue over the Task-1 helpers (exhaustively unit-tested) and live in a Supabase-coupled server module that this repo does not unit-test directly. Their correctness is covered by the helper tests + `tsc` + the manual run in Task 10. This is an intentional boundary, not an omitted test.

- [ ] **Step 5: Commit**

```bash
git add app/lib/calderyn.server.ts app/lib/types.ts app/components/dashboard/view-models.ts
git commit -m "calderyn.server: persist business-hours window + business_hours_only"
```
(Includes the Task-2 type files if not already committed — keeps `tsc`-green commits.)

---

### Task 6: `GuardrailField` component (presets + custom reveal)

**Files:**
- Create: `app/components/dashboard/GuardrailField.tsx`
- Test: `app/components/dashboard/__tests__/guardrail-field.test.ts`

**Interfaces:**
- Produces:
  - `activePreset(value: number, presetValues: number[]): string` — returns `String(value)` if it matches a preset, else `"__custom__"`.
  - `GuardrailField` React component (props below).

- [ ] **Step 1: Write the failing tests**

Create `app/components/dashboard/__tests__/guardrail-field.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { GuardrailField, activePreset } from "../GuardrailField";

const PRESETS = [
  { value: 25000, label: "$250" },
  { value: 50000, label: "$500" },
  { value: 100000, label: "$1,000" },
];

describe("activePreset", () => {
  it("returns the matching preset string", () => {
    expect(activePreset(50000, [25000, 50000, 100000])).toBe("50000");
  });
  it("returns __custom__ for an off-preset value", () => {
    expect(activePreset(75000, [25000, 50000, 100000])).toBe("__custom__");
  });
});

describe("GuardrailField render", () => {
  it("does not show the custom input when the value matches a preset", () => {
    const html = renderToString(
      h(GuardrailField, { value: 50000, presets: PRESETS, onCommit: () => {} }),
    );
    expect(html).toContain("Custom");
    expect(html).not.toContain('type="number"');
  });
  it("shows the custom input pre-filled when the value is off-preset", () => {
    const html = renderToString(
      h(GuardrailField, {
        value: 75000,
        presets: PRESETS,
        onCommit: () => {},
        toInput: (c: number) => String(c / 100),
        suffix: "USD/day",
      }),
    );
    expect(html).toContain('type="number"');
    expect(html).toContain('value="750"');
    expect(html).toContain("USD/day");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- app/components/dashboard/__tests__/guardrail-field.test.ts`
Expected: FAIL (`Failed to resolve import "../GuardrailField"`).

- [ ] **Step 3: Implement the component**

Create `app/components/dashboard/GuardrailField.tsx`:
```tsx
// A guardrail control: preset chips + a "Custom" reveal that shows a number
// input. Reused for every numeric guardrail. Pure preset-matching is exported
// for unit tests; the input commits on blur or Enter, presets commit on click.
import { useEffect, useState } from "react";
import { Segmented } from "./ui";

const CUSTOM = "__custom__";

export function activePreset(value: number, presetValues: number[]): string {
  return presetValues.includes(value) ? String(value) : CUSTOM;
}

export function GuardrailField({
  value,
  presets,
  onCommit,
  toInput,
  fromInput,
  suffix,
  disabled,
}: {
  value: number;
  presets: { value: number; label: string }[];
  onCommit: (next: number) => void;
  /** stored unit -> input display (e.g. cents -> dollars). Defaults to String(value). */
  toInput?: (v: number) => string;
  /** input string -> stored unit; return null to reject (e.g. dollars -> cents). */
  fromInput?: (raw: string) => number | null;
  suffix?: string;
  disabled?: boolean;
}) {
  const presetValues = presets.map((p) => p.value);
  const [mode, setMode] = useState(activePreset(value, presetValues));
  const [draft, setDraft] = useState(toInput ? toInput(value) : String(value));

  // Re-sync when the upstream value changes (refresh / optimistic revert).
  useEffect(() => {
    setMode(activePreset(value, presetValues));
    setDraft(toInput ? toInput(value) : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const options = [
    ...presets.map((p) => ({ value: String(p.value), label: p.label })),
    { value: CUSTOM, label: "Custom" },
  ];

  const commitDraft = () => {
    const parsed = fromInput ? fromInput(draft) : Number(draft);
    if (parsed === null || parsed === undefined || Number.isNaN(parsed)) return;
    onCommit(parsed);
  };

  return (
    <div className="cd-guardrail-field">
      <Segmented
        small
        value={mode}
        options={options}
        onChange={(v) => {
          setMode(v);
          if (v !== CUSTOM) onCommit(Number(v));
        }}
      />
      {mode === CUSTOM && (
        <label className="cd-field" style={{ marginTop: 8, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <input
            className="cd-input tabular-nums"
            type="number"
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitDraft();
            }}
          />
          {suffix && <span className="cd-caption">{suffix}</span>}
        </label>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test -- app/components/dashboard/__tests__/guardrail-field.test.ts`
Expected: PASS (4 cases).

- [ ] **Step 5: Commit**

```bash
git add app/components/dashboard/GuardrailField.tsx app/components/dashboard/__tests__/guardrail-field.test.ts
git commit -m "components/dashboard: add GuardrailField (presets + custom reveal)"
```

---

### Task 7: `BusinessHoursEditor` component

**Files:**
- Create: `app/components/dashboard/BusinessHoursEditor.tsx`
- Test: `app/components/dashboard/__tests__/business-hours-editor.test.ts`

**Interfaces:**
- Produces: `BusinessHoursEditor` React component. `onChangeWindow` always emits a full `{ start, end, tz }` triple (so it satisfies the validator); `onToggle` emits the `business_hours_only` boolean.

- [ ] **Step 1: Write the failing test**

Create `app/components/dashboard/__tests__/business-hours-editor.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { BusinessHoursEditor } from "../BusinessHoursEditor";

const base = {
  start: "09:00",
  end: "17:00",
  tz: "America/New_York",
  onToggle: () => {},
  onChangeWindow: () => {},
};

describe("BusinessHoursEditor render", () => {
  it("hides the window selects when disabled (off)", () => {
    const html = renderToString(h(BusinessHoursEditor, { ...base, enabled: false }));
    expect(html).toContain("Only act during business hours");
    expect(html).not.toContain("<select");
  });
  it("shows the start/end selects and the timezone when on", () => {
    const html = renderToString(h(BusinessHoursEditor, { ...base, enabled: true }));
    expect(html).toContain("<select");
    expect(html).toContain("America/New_York");
    // selected hours reflect the props
    expect(html).toContain('value="09:00" selected');
    expect(html).toContain('value="17:00" selected');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- app/components/dashboard/__tests__/business-hours-editor.test.ts`
Expected: FAIL (`Failed to resolve import "../BusinessHoursEditor"`).

- [ ] **Step 3: Implement the component**

Create `app/components/dashboard/BusinessHoursEditor.tsx`:
```tsx
// Business-hours window editor: a single "only act during business hours"
// toggle, and (when on) whole-hour start/end selects in the store's timezone.
// No timezone picker — the merchant edits wall-clock hours; the server hides
// the UTC conversion. onChangeWindow always emits the full {start,end,tz}.
import { Toggle } from "./ui";

const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);

export function BusinessHoursEditor({
  enabled,
  start,
  end,
  tz,
  onToggle,
  onChangeWindow,
  disabled,
}: {
  enabled: boolean;
  start: string;
  end: string;
  tz: string;
  onToggle: (on: boolean) => void;
  onChangeWindow: (next: { start: string; end: string; tz: string }) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <div className="cd-setting">
        <div className="min-w-0 flex-1">
          <div className="cd-row-title">Only act during business hours</div>
          <div className="cd-caption" style={{ maxWidth: "46ch" }}>
            Outside this window, actions queue for review. Times are in {tz}.
          </div>
        </div>
        <Toggle value={enabled} disabled={disabled} onChange={onToggle} />
      </div>
      {enabled && (
        <div className="cd-setting">
          <div className="min-w-0 flex-1">
            <div className="cd-row-title">Window</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select
              className="cd-input"
              value={start}
              disabled={disabled}
              onChange={(e) => onChangeWindow({ start: e.target.value, end, tz })}
            >
              {HOURS.map((hh) => (
                <option key={hh} value={hh}>
                  {hh}
                </option>
              ))}
            </select>
            <span className="cd-caption">to</span>
            <select
              className="cd-input"
              value={end}
              disabled={disabled}
              onChange={(e) => onChangeWindow({ start, end: e.target.value, tz })}
            >
              {HOURS.map((hh) => (
                <option key={hh} value={hh}>
                  {hh}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test -- app/components/dashboard/__tests__/business-hours-editor.test.ts`
Expected: PASS (2 cases).

- [ ] **Step 5: Commit**

```bash
git add app/components/dashboard/BusinessHoursEditor.tsx app/components/dashboard/__tests__/business-hours-editor.test.ts
git commit -m "components/dashboard: add BusinessHoursEditor"
```

---

### Task 8: Wire the dashboard Settings screen

Replace the fixed `Segmented` numeric rows with `GuardrailField`, swap the read-only business-hours pill for `BusinessHoursEditor`, and add the two scale-up fields under the autopilot block.

**Files:**
- Modify: `app/components/dashboard/screens/Settings.tsx`

**Interfaces:**
- Consumes: `GuardrailField` (Task 6), `BusinessHoursEditor` (Task 7), `commit<K extends keyof GuardrailConfig>(key, value)` (existing in this file), `g.business_hours_only` (Task 2).

- [ ] **Step 1: Add imports**

At the top of `app/components/dashboard/screens/Settings.tsx`, add:
```ts
import { GuardrailField } from "../GuardrailField";
import { BusinessHoursEditor } from "../BusinessHoursEditor";
```
The `Segmented` import can stay (used elsewhere — shipping mode).

- [ ] **Step 2: Replace the "Daily action budget", "Per-action dollar cap", "Cooldown" `Segmented`s with `GuardrailField`**

In the `Guardrails` section, replace each control. Daily budget:
```tsx
            <GuardrailField
              value={g.daily_action_budget_cents}
              presets={[
                { value: 25000, label: "$250" },
                { value: 50000, label: "$500" },
                { value: 100000, label: "$1,000" },
              ]}
              toInput={(c) => String(Math.round(c / 100))}
              fromInput={(raw) => {
                const n = Number(raw);
                return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
              }}
              suffix="USD/day"
              disabled={saving}
              onCommit={(v) => commit("daily_action_budget_cents", v)}
            />
```
Per-action cap (same shape, presets `10000/25000/50000` → `$100/$250/$500`, suffix `"USD"`, key `dollar_cap_cents`).
Cooldown (identity, presets `15/30/60` → `15m/30m/1h`, suffix `"minutes"`, key `cooldown_minutes`):
```tsx
            <GuardrailField
              value={g.cooldown_minutes}
              presets={[
                { value: 15, label: "15m" },
                { value: 30, label: "30m" },
                { value: 60, label: "1h" },
              ]}
              fromInput={(raw) => {
                const n = Number(raw);
                return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
              }}
              suffix="minutes"
              disabled={saving}
              onCommit={(v) => commit("cooldown_minutes", v)}
            />
```

- [ ] **Step 3: Replace the read-only "Business hours only" row with `BusinessHoursEditor`**

Delete the existing `SettingRow label="Business hours only"` block (the one rendering the `Pill`) and the now-unused `TODO` comment, and render the editor inside the same `Card`:
```tsx
          <BusinessHoursEditor
            enabled={g.business_hours_only}
            start={g.business_hours.start}
            end={g.business_hours.end}
            tz={g.business_hours.tz}
            disabled={saving}
            onToggle={(on) =>
              commit("business_hours_only", on, on ? "Business-hours window on." : "Business-hours window off.")
            }
            onChangeWindow={(next) => commit("business_hours", next, "Business hours updated")}
          />
```

- [ ] **Step 4: Add the two scale-up fields under the autopilot block**

Inside the `g.autopilot_enabled && (...)` group in the `Autopilot` section, after the "Max budget cut" row, add Max budget increase (key `autopilot_max_budget_increase_pct`, identity, presets `10/20/50` → `10%/20%/50%`, suffix `%`) using `GuardrailField`, and the nullable daily ceiling as a toggle + field:
```tsx
              <SettingRow
                label="Max budget increase"
                sub="Autopilot never raises a campaign budget by more than this in one step."
              >
                <GuardrailField
                  value={g.autopilot_max_budget_increase_pct}
                  presets={[
                    { value: 10, label: "10%" },
                    { value: 20, label: "20%" },
                    { value: 50, label: "50%" },
                  ]}
                  fromInput={(raw) => {
                    const n = Number(raw);
                    return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : null;
                  }}
                  suffix="%"
                  disabled={saving}
                  onCommit={(v) => commit("autopilot_max_budget_increase_pct", v)}
                />
              </SettingRow>
              <SettingRow
                label="Daily budget ceiling"
                sub="A hard cap on how high autopilot can push any one campaign's daily budget."
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Toggle
                    value={g.autopilot_max_daily_budget_cents !== null}
                    disabled={saving}
                    onChange={(on) =>
                      commit("autopilot_max_daily_budget_cents", on ? 50000 : null)
                    }
                  />
                  {g.autopilot_max_daily_budget_cents !== null && (
                    <GuardrailField
                      value={g.autopilot_max_daily_budget_cents}
                      presets={[
                        { value: 25000, label: "$250" },
                        { value: 50000, label: "$500" },
                        { value: 100000, label: "$1,000" },
                      ]}
                      toInput={(c) => String(Math.round(c / 100))}
                      fromInput={(raw) => {
                        const n = Number(raw);
                        return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
                      }}
                      suffix="USD/day"
                      disabled={saving}
                      onCommit={(v) => commit("autopilot_max_daily_budget_cents", v)}
                    />
                  )}
                </div>
              </SettingRow>
```
`Toggle` is already imported in this file. The `commit` signature already accepts `null` for the nullable key (its value type is `GuardrailVM[K]`, which is `number | null` here).

- [ ] **Step 5: Typecheck + build**

Run:
```bash
npm run typecheck
npm run build
```
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/components/dashboard/screens/Settings.tsx
git commit -m "screens/Settings: custom guardrail fields + business-hours editor + scale-up caps"
```

---

### Task 9: Mirror onto the embedded Polaris admin

The embedded admin already uses free-form number fields for budget/cap/cooldown/autopilot. Add the business-hours editor (replacing the disabled field + its TODO) and the two scale-up fields, and route the action through the shared validator via a new exported pure parser (mirroring the file's existing `parsePeriodTotalForm` / `parseManualOverrideForm` pattern).

**Files:**
- Modify: `app/routes/app.settings.tsx`
- Test: `app/routes/__tests__/app.settings.guardrails.test.ts` (new — unit-tests the exported parser)

**Interfaces:**
- Consumes: `validateGuardrailPatch` (Task 3); `localHourToUtc` is **not** needed here (the server `guardrails.update` does the conversion; the form sends `business_hours: { start, end, tz }`).
- Produces: `parseGuardrailForm(fd: FormData): Partial<GuardrailConfig>` exported from `app/routes/app.settings.tsx`.

- [ ] **Step 1: Write the failing parser test**

Create `app/routes/__tests__/app.settings.guardrails.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseGuardrailForm } from "../app.settings";

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

describe("parseGuardrailForm", () => {
  it("parses budget/cap/cooldown (cents) and autopilot fields", () => {
    const patch = parseGuardrailForm(
      fd({
        daily_action_budget_cents: "75000",
        dollar_cap_cents: "20000",
        cooldown_minutes: "45",
        autopilot_enabled: "true",
        autopilot_max_budget_increase_pct: "25",
      }),
    );
    expect(patch.daily_action_budget_cents).toBe(75000);
    expect(patch.cooldown_minutes).toBe(45);
    expect(patch.autopilot_enabled).toBe(true);
    expect(patch.autopilot_max_budget_increase_pct).toBe(25);
  });

  it("parses the business-hours window + only toggle", () => {
    const patch = parseGuardrailForm(
      fd({
        business_hours_only: "true",
        bh_start: "09:00",
        bh_end: "17:00",
        bh_tz: "America/New_York",
      }),
    );
    expect(patch.business_hours_only).toBe(true);
    expect(patch.business_hours).toEqual({ start: "09:00", end: "17:00", tz: "America/New_York" });
  });

  it("parses a null daily ceiling when 'none' is submitted", () => {
    const patch = parseGuardrailForm(fd({ autopilot_max_daily_budget_cents: "" }));
    expect(patch.autopilot_max_daily_budget_cents).toBeNull();
  });

  it("omits keys that are absent", () => {
    expect(parseGuardrailForm(fd({}))).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- app/routes/__tests__/app.settings.guardrails.test.ts`
Expected: FAIL (`parseGuardrailForm` is not exported).

- [ ] **Step 3: Add the exported parser**

In `app/routes/app.settings.tsx`, near the other exported parsers (after `parseManualOverrideForm`), add:
```ts
export function parseGuardrailForm(fd: FormData): Partial<GuardrailConfig> {
  const patch: Partial<GuardrailConfig> = {};
  const num = (key: keyof GuardrailConfig, raw: FormDataEntryValue | null, xform = (n: number) => n) => {
    if (raw === null) return;
    const n = Number(String(raw));
    if (Number.isFinite(n)) (patch as Record<string, unknown>)[key] = xform(n);
  };
  num("daily_action_budget_cents", fd.get("daily_action_budget_cents"), (n) => Math.max(0, Math.round(n)));
  num("dollar_cap_cents", fd.get("dollar_cap_cents"), (n) => Math.max(0, Math.round(n)));
  num("cooldown_minutes", fd.get("cooldown_minutes"), (n) => Math.max(0, Math.round(n)));
  if (fd.get("autopilot_enabled") !== null) {
    patch.autopilot_enabled = String(fd.get("autopilot_enabled")) === "true";
  }
  num("autopilot_daily_action_cap", fd.get("autopilot_daily_action_cap"), (n) => Math.max(0, Math.round(n)));
  num("autopilot_min_spend_cents", fd.get("autopilot_min_spend_cents"), (n) => Math.max(0, Math.round(n * 100)));
  num("autopilot_max_budget_cut_pct", fd.get("autopilot_max_budget_cut_pct"), (n) => Math.max(0, Math.round(n)));
  num("autopilot_max_budget_increase_pct", fd.get("autopilot_max_budget_increase_pct"), (n) => Math.max(0, Math.round(n)));
  // Daily ceiling: empty string clears it (null = no cap); otherwise dollars -> cents.
  const ceilRaw = fd.get("autopilot_max_daily_budget_cents");
  if (ceilRaw !== null) {
    const s = String(ceilRaw).trim();
    if (s === "") patch.autopilot_max_daily_budget_cents = null;
    else {
      const n = Number(s);
      if (Number.isFinite(n)) patch.autopilot_max_daily_budget_cents = Math.max(0, Math.round(n * 100));
    }
  }
  if (fd.get("business_hours_only") !== null) {
    patch.business_hours_only = String(fd.get("business_hours_only")) === "true";
  }
  const bhStart = fd.get("bh_start");
  const bhEnd = fd.get("bh_end");
  const bhTz = fd.get("bh_tz");
  if (bhStart !== null && bhEnd !== null && bhTz !== null) {
    patch.business_hours = { start: String(bhStart), end: String(bhEnd), tz: String(bhTz) };
  }
  return patch;
}
```

- [ ] **Step 4: Use the parser + validator in the `update_guardrails` action branch**

Replace the body of the `if (intent === "update_guardrails") { ... }` branch with:
```ts
    if (intent === "update_guardrails") {
      const patch = parseGuardrailForm(formData);
      if (validateGuardrailPatch(patch) !== null) {
        return json<ActionPayload>(
          {
            ok: false,
            error: { code: "INVALID_GUARDRAILS", message: "Those guardrail values are out of range." },
            toast: { message: "Those guardrail values are out of range.", isError: true },
          },
          { status: 422 },
        );
      }
      await client.guardrails.update(patch, request.signal);
      return json<ActionPayload>({ ok: true, toast: { message: "Guardrails updated" } });
    }
```
Add the import at the top: `import { validateGuardrailPatch } from "~/lib/dashboard/guardrails-validation";`

- [ ] **Step 5: Add the UI fields to `GuardrailsCard`**

In the `GuardrailsCard` component, (a) replace the **disabled** "Business hours" `TextField` (and its TODO) with a `Checkbox` (`business_hours_only`) plus two `Select`s for start/end whole hours, posting hidden inputs `business_hours_only`, `bh_start`, `bh_end`, `bh_tz`; and (b) add two `TextField`s for `autopilot_max_budget_increase_pct` (%) and the daily ceiling (USD, blank = no cap) inside the `autopilotEnabled` block, with matching hidden inputs. Use the existing `useState` + hidden-input submission pattern already in `GuardrailsCard`. Seed the hour `Select`s and the toggle from `guardrails.business_hours` / `guardrails.business_hours_only`, and seed the ceiling field from `guardrails.autopilot_max_daily_budget_cents` (`null` → empty string). Hour options: `Array.from({length:24}, (_,h) => \`${String(h).padStart(2,"0")}:00\`)`.

(Exact JSX mirrors the existing `TextField`/hidden-input wiring in this component; follow that established pattern. The hidden-input names must be `business_hours_only`, `bh_start`, `bh_end`, `bh_tz`, `autopilot_max_budget_increase_pct`, `autopilot_max_daily_budget_cents` to match `parseGuardrailForm`.)

- [ ] **Step 6: Run parser test + typecheck + build**

Run:
```bash
npm run test -- app/routes/__tests__/app.settings.guardrails.test.ts
npm run typecheck
npm run build
```
Expected: parser test PASS (4 cases); typecheck + build exit 0.

- [ ] **Step 7: Commit**

```bash
git add app/routes/app.settings.tsx app/routes/__tests__/app.settings.guardrails.test.ts
git commit -m "routes/app.settings: editable business hours + scale-up caps + shared validation"
```

---

### Task 10: Pre-commit gate + finish

**Files:** none (verification + integration).

- [ ] **Step 1: Full test suite**

Run: `npm run test`
Expected: all PASS (including the unchanged enforcement-path and stat-row tests).

- [ ] **Step 2: Typecheck, lint, build**

Run:
```bash
npm run typecheck
npm run lint
npm run build
```
Expected: each exit 0; lint has no new warnings on touched files.

- [ ] **Step 3: `/code-review` the working tree**

Run the `/code-review` slash command. Resolve every blocker; downgrade nits with a one-line justification. (Per `CLAUDE.md` pre-commit gate.)

- [ ] **Step 4: Manual smoke (per `CLAUDE.md` rule 12 — evidence, not assertion)**

Verify on the dashboard Settings screen against the prod Supabase test shop: set a custom daily budget (e.g. $750) and confirm it persists after refresh; toggle "Only act during business hours" and set 09:00–17:00, confirm the displayed window is correct local time (not a UTC hour); turn autopilot on and set a daily budget ceiling, then clear it (no cap). Repeat the business-hours edit on the embedded admin Settings page. Capture the result.

- [ ] **Step 5: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to merge `feat/custom-guardrails` and remove the worktree (`git worktree remove ../calderyn-custom-guardrails`), per the feature-isolation rule.

---

## Self-Review

**Spec coverage:**
- Goal 1 (custom numeric values, presets + custom): Tasks 6, 8 (dashboard); embedded admin already free-form, extended in 9. ✓
- Goal 2 (business hours editable, both surfaces): Tasks 1 (conversion), 5 (persist), 7 + 8 (dashboard UI), 9 (embedded UI). ✓
- Goal 3 (scale-up caps settable): Tasks 4 (allow-list), 8 (dashboard UI), 9 (embedded UI). ✓
- Goal 4 (single bounded validator, both surfaces): Tasks 3 (validator), 4 (dashboard route), 9 (embedded action). ✓
- Non-goal "keep merchant screen simple": presets-first + Custom reveal (6/8), scale-up under off-by-default autopilot (8), no tz picker (7). ✓
- "No DB migration / no enforcement-path change": confirmed — `in_business_hours` stays on raw UTC hours (Task 5); no migration files. ✓
- Display-bug fix (UTC hour mislabeled): Task 5 `utcHourToLocal`. ✓

**Placeholder scan:** Every code step shows real code. Task 9 Step 5 describes the Polaris JSX by pattern rather than full markup — this is deliberate (it mirrors the verbose existing `GuardrailsCard` hidden-input wiring already in the file), and it pins the exact hidden-input names the tested `parseGuardrailForm` depends on, so there is no ambiguity about the contract. No "TBD"/"handle edge cases"/"write tests for the above".

**Type consistency:** `business_hours_only: boolean` added to both `GuardrailConfig` (Task 2) and `GuardrailVM` (Task 2); produced by `rowToGuardrails` (Task 5); consumed in `Settings.tsx` (Task 8). `GuardrailField` props (`value`/`presets`/`onCommit`/`toInput`/`fromInput`/`suffix`/`disabled`) match between Task 6 definition and Task 8 usage. `activePreset(value, presetValues: number[])` consistent. `localHourToUtc`/`utcHourToLocal` signatures match between Task 1 and Task 5. `parseGuardrailForm` hidden-input names match between Task 9 parser (Step 3) and UI (Step 5).

**Coverage boundary (stated, not silent):** `rowToGuardrails`/`guardrails.update` glue is covered by helper unit tests + `tsc` + the Task-10 manual smoke, not a server-module unit test (the module is Supabase-coupled and not unit-tested in this repo). Dashboard component interaction (click/blur commits) is not exercised by `renderToString`; only static structure is asserted — interaction is verified in the Task-10 smoke.
