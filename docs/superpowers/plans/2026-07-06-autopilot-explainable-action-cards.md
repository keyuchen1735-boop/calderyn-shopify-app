# Autopilot Explainable Action Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn each pending proposal in the Autopilot calibration queue into a self-explaining card — plain-language action, subject, reason, dollar stake, and clear approve/reject — so a first-time merchant understands and uses Autopilot.

**Architecture:** Pure front-end change to the `CalibrationTrainer` rows in `app/components/dashboard/screens/Autopilot.tsx`. Two pure presentation helpers are extracted into a new client module and unit-tested; the row markup is rewritten to a card; new `cd-actcard*` CSS is added. No server, view-model, or DB change — every field consumed (`title`, `action_kind`, `detector_id`, `reasoning`, `dollar_impact`, `confidence`, `always_ask`, `over_autopilot_cap`) already exists on `QueueProposalVM`, and label helpers already exist in `app/lib/labels.ts`.

**Tech Stack:** React 18 + TypeScript (strict), Vitest (`vitest run`), custom `cd-*` design system in `app/styles/dashboard.css`, Lucide via `CDIcon`.

## Global Constraints

- **TypeScript only**; no `any` without written justification — prefer `unknown` + narrowing. `tsc --noEmit` is authoritative.
- **Dashboard surface only** (`app/components/dashboard/*`, `app/lib/*`); do NOT touch `app/routes/app.*` or `app/components/calderyn/*` (legacy-frozen).
- **UI primitives:** compose with existing `cd-*` classes and the `Btn` component (`kind?: "primary" | "secondary"`, `small?`, `icon?`, `disabled?`, `onClick?`). Icons only via `CDIcon` / `CD_ACTION_ICON`. No new deps, no Polaris.
- **Browser-visible source hygiene:** no AI/provenance/design-tool markers, TODOs, or internal comments in any browser-visible string, comment, or identifier. `npm run build` runs `scripts/verify-client-bundle.mjs` — do not weaken it.
- **No em/en dashes** in generated user-facing copy.
- **Pre-commit gate** before any commit beyond a nit: `npm run typecheck` (exit 0) → `npm run lint` (0 warnings on touched files) → `npm run build` (exit 0). Run in order, show output, never `--no-verify`.
- **Feature isolation:** do this work in an isolated worktree/branch `feat/autopilot-action-cards`, not on `main`.

---

### Task 1: Pure presentation helpers (`autopilot-cards.ts`) + unit tests

Extract the two bits of display logic that have real branching — the dollar-impact verb and the reason fallback — into a pure, dependency-light client module so they are unit-testable without rendering React.

**Files:**
- Create: `app/components/dashboard/screens/autopilot-cards.ts`
- Test: `app/components/dashboard/screens/__tests__/autopilot-cards.test.ts`

**Interfaces:**
- Consumes: `ActionKind`, `DetectorId` types from `~/lib/types`; `detectorLabel` from `~/lib/labels`.
- Produces:
  - `moneyVerb(actionKind: string): "Keeps" | "Earns"` — growth actions return `"Earns"`, everything else `"Keeps"`.
  - `reasonLines(reasoning: string | null | undefined, detectorId: string): { category: string; narrative: string | null }` — `category` is always `detectorLabel(detectorId)`; `narrative` is the trimmed `reasoning` or `null` when blank.

- [ ] **Step 1: Write the failing test**

```ts
// app/components/dashboard/screens/__tests__/autopilot-cards.test.ts
import { describe, it, expect } from "vitest";
import { moneyVerb, reasonLines } from "../autopilot-cards";

describe("moneyVerb", () => {
  it("returns Earns for growth actions", () => {
    expect(moneyVerb("increase_campaign_budget")).toBe("Earns");
    expect(moneyVerb("reallocate_budget")).toBe("Earns");
    expect(moneyVerb("reallocate_spend_sku")).toBe("Earns");
    expect(moneyVerb("create_po_draft")).toBe("Earns");
  });

  it("returns Keeps for loss-stopping and unknown actions", () => {
    expect(moneyVerb("pause_campaign")).toBe("Keeps");
    expect(moneyVerb("reduce_campaign_budget")).toBe("Keeps");
    expect(moneyVerb("exclude_geo")).toBe("Keeps");
    expect(moneyVerb("something_new")).toBe("Keeps");
  });
});

describe("reasonLines", () => {
  it("returns the narrative when present, trimmed", () => {
    const r = reasonLines("  Spend up 40% but sales flat.  ", "campaign_below_breakeven");
    expect(r.category).toBe("Campaign is losing money");
    expect(r.narrative).toBe("Spend up 40% but sales flat.");
  });

  it("falls back to category only when narrative is blank", () => {
    expect(reasonLines("", "campaign_below_breakeven").narrative).toBeNull();
    expect(reasonLines("   ", "campaign_below_breakeven").narrative).toBeNull();
    expect(reasonLines(null, "campaign_below_breakeven").narrative).toBeNull();
    expect(reasonLines(undefined, "campaign_below_breakeven").narrative).toBeNull();
  });

  it("uses detectorLabel for the category, humanizing unknown ids", () => {
    expect(reasonLines("x", "campaign_below_breakeven").category).toBe("Campaign is losing money");
    expect(reasonLines("x", "brand_new_detector").category).toBe("Brand New Detector");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/components/dashboard/screens/__tests__/autopilot-cards.test.ts`
Expected: FAIL — cannot resolve `../autopilot-cards` (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// app/components/dashboard/screens/autopilot-cards.ts
import { detectorLabel } from "~/lib/labels";

// Actions that grow revenue (scale spend, reorder stock) frame their dollar
// figure as money earned; every other queued action stops a loss, so its
// figure is money kept. Unknown/future kinds default to "Keeps".
const GROWTH_ACTIONS = new Set<string>([
  "increase_campaign_budget",
  "reallocate_budget",
  "reallocate_spend_sku",
  "create_po_draft",
]);

/** Verb that frames a proposal's dollar impact as a benefit. */
export function moneyVerb(actionKind: string): "Keeps" | "Earns" {
  return GROWTH_ACTIONS.has(actionKind) ? "Earns" : "Keeps";
}

/**
 * The two lines of a proposal's "why": the plain-language problem category
 * (always present) and the alert narrative (null when the alert has none, so
 * the card can render the category alone).
 */
export function reasonLines(
  reasoning: string | null | undefined,
  detectorId: string,
): { category: string; narrative: string | null } {
  const narrative = typeof reasoning === "string" ? reasoning.trim() : "";
  return {
    category: detectorLabel(detectorId),
    narrative: narrative.length > 0 ? narrative : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/components/dashboard/screens/__tests__/autopilot-cards.test.ts`
Expected: PASS (3 `reasonLines` + 2 `moneyVerb` assertions green).

- [ ] **Step 5: Commit**

```bash
git add app/components/dashboard/screens/autopilot-cards.ts app/components/dashboard/screens/__tests__/autopilot-cards.test.ts
git commit -m "dashboard/Autopilot: pure helpers for action-card money verb and reason fallback"
```

---

### Task 2: `cd-actcard` styles

Add the card styling. Reuse existing color tokens and chip/button styles already in the file — this task adds only layout/spacing classes.

**Files:**
- Modify: `app/styles/dashboard.css` (append a new block near the existing `.cd-sug-row` / `.cd-reject-panel` rules)

**Interfaces:**
- Produces CSS classes consumed by Task 3: `.cd-actcard`, `.cd-actcard-hd`, `.cd-actcard-title`, `.cd-actcard-subj`, `.cd-actcard-conf`, `.cd-actcard-why`, `.cd-actcard-why-cat`, `.cd-actcard-foot`, `.cd-actcard-money`, `.cd-actcard-acts`.

- [ ] **Step 1: Locate the insertion point**

Run: `grep -n "cd-reject-panel" app/styles/dashboard.css | head -1`
Expected: a line number for the existing reject-panel rule. Insert the new block immediately after that rule's closing brace so card styles sit beside the queue styles they relate to.

- [ ] **Step 2: Append the card styles**

Add this block at the insertion point (values follow the existing token vocabulary in the file — verify `--text-1`, `--text-2`, `--line`, `--accent` exist near the top of the file; if a token name differs, use the file's actual equivalent):

```css
/* Autopilot calibration queue — explainable action cards */
.cd-actcard {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface-1, transparent);
}
.cd-actcard + .cd-actcard { margin-top: 10px; }
.cd-actcard-hd {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.cd-actcard-hd .cd-sug-ico { flex-shrink: 0; }
.cd-actcard-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  color: var(--text-1);
  line-height: 1.3;
}
.cd-actcard-subj {
  font-weight: 400;
  color: var(--text-2);
  font-size: 12.5px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cd-actcard-conf {
  flex-shrink: 0;
  font-size: 12.5px;
  color: var(--text-2);
  white-space: nowrap;
}
.cd-actcard-conf b { color: var(--text-1); }
.cd-actcard-why {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.45;
}
.cd-actcard-why-cat { color: var(--text-1); font-weight: 500; }
.cd-actcard-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.cd-actcard-money {
  font-size: 13px;
  color: var(--text-2);
  margin-right: auto;
}
.cd-actcard-money b { color: var(--text-1); }
.cd-actcard-acts { display: flex; gap: 8px; }
```

- [ ] **Step 3: Verify the build still compiles the CSS**

Run: `npm run build`
Expected: exit 0 (Remix + Vite build completes; `verify-client-bundle.mjs` passes). CSS-only change, no JS behavior yet.

- [ ] **Step 4: Commit**

```bash
git add app/styles/dashboard.css
git commit -m "dashboard/Autopilot: styles for explainable action cards"
```

---

### Task 3: Rewrite the calibration rows as cards + orientation line

Replace the `cd-sug-row` markup inside `CalibrationTrainer`'s `queue.map(...)` with the card, wire in the label helpers, and add the one-line orientation copy under the header. All handlers (`approve`, `reject`, `teachingBusy`, `rejecting`/`note` state) stay exactly as they are — only markup and the strings it renders change.

**Files:**
- Modify: `app/components/dashboard/screens/Autopilot.tsx`

**Interfaces:**
- Consumes: `moneyVerb`, `reasonLines` from `./autopilot-cards` (Task 1); `featureLabel` from `~/lib/labels`; existing `money`, `CDIcon`, `CD_ACTION_ICON`, `Btn`, `REJECT_CHIPS`, `canOneClick`, `approve`, `reject`, `teachingBusy`, `approving`, `rejecting`, `note`, `setRejecting`, `setNote`.
- `QueueProposalVM` fields used: `alertId`, `detector_id`, `action_kind`, `title`, `dollar_impact`, `confidence`. The `always_ask` / `over_autopilot_cap` flags live only on the server `QueueProposal` and are NOT on `QueueProposalVM` — badges for them are deferred (see Notes). Do not add server plumbing in this task.

- [ ] **Step 1: Add imports**

At the top of `app/components/dashboard/screens/Autopilot.tsx`, add:

```ts
import { featureLabel } from "~/lib/labels";
import { moneyVerb, reasonLines } from "./autopilot-cards";
```

(`money`, `CDIcon`, `CD_ACTION_ICON`, `Btn` are already imported.)

- [ ] **Step 2: Add the orientation line under the header**

In `CalibrationTrainer`, find the header row that renders the "Approve to train" title and `{queue.length} left`. Immediately after that flex container's closing `</div>`, insert:

```tsx
<div className="cd-caption" style={{ padding: "0 20px 6px", lineHeight: 1.4 }}>
  Calderyn spotted these while watching your store. Approve the good calls to
  teach it, and soon it handles them for you.
</div>
```

- [ ] **Step 3: Replace the row markup**

Replace the entire `<div className="cd-sug-row" ...> ... </div>` block (the proposal row, NOT the `{rejecting === p.alertId && (...)}` reject panel that follows it) with the card below. Keep it inside the existing `<Fragment key={p.alertId}>`, and keep the reject-panel block that follows unchanged.

```tsx
<div className="cd-actcard">
  <div className="cd-actcard-hd">
    <span className="cd-sug-ico cd-actcard-ico">
      <CDIcon name={CD_ACTION_ICON[p.action_kind] ?? "bolt"} size={17} strokeWidth={1.8} />
    </span>
    <div className="cd-actcard-title">
      {featureLabel(p.detector_id, p.action_kind)}
      <div className="cd-actcard-subj">{p.title}</div>
    </div>
    <span className="cd-actcard-conf">
      <b className="tabular-nums">{p.confidence}%</b> sure
    </span>
  </div>

  {(() => {
    const r = reasonLines(p.reasoning, p.detector_id);
    return (
      <div className="cd-actcard-why">
        <span className="cd-actcard-why-cat">Why: {r.category}.</span>
        {r.narrative ? ` ${r.narrative}` : ""}
      </div>
    );
  })()}

  <div className="cd-actcard-foot">
    {p.dollar_impact !== 0 && (
      <span className="cd-actcard-money">
        {moneyVerb(p.action_kind)}{" "}
        <b className="tabular-nums">~{money(p.dollar_impact)}</b>
      </span>
    )}
    <div className="cd-actcard-acts">
      <button
        type="button"
        className="cd-btn cd-btn-secondary cd-btn-sm"
        aria-expanded={rejecting === p.alertId}
        aria-controls={`cd-reject-${p.alertId}`}
        disabled={teachingBusy}
        onClick={() => {
          setRejecting((cur) => (cur === p.alertId ? null : p.alertId));
          setNote("");
        }}
      >
        Not now
      </button>
      <Btn kind="primary" small disabled={teachingBusy} onClick={() => approve(p)}>
        {approving === p.alertId
          ? "Doing…"
          : canOneClick(p)
            ? "Do it"
            : "Review"}
      </Btn>
    </div>
  </div>
</div>
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: exit 0. If TS reports `p.reasoning` missing, confirm `reasoning` is on `QueueProposalVM` (it is — `app/components/dashboard/view-models.ts:291`). If it reports `always_ask`/`over_autopilot_cap` — this task does not reference them, so no error expected.

- [ ] **Step 5: Lint the touched files**

Run: `npx eslint --max-warnings=0 app/components/dashboard/screens/Autopilot.tsx app/components/dashboard/screens/autopilot-cards.ts`
Expected: exit 0, no warnings.

- [ ] **Step 6: Commit**

```bash
git add app/components/dashboard/screens/Autopilot.tsx
git commit -m "dashboard/Autopilot: render calibration queue as explainable action cards"
```

---

### Task 4: Full verification gate + branch finish

Run the repo pre-commit gate end-to-end and confirm the visual result before considering the feature done.

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite (no regressions)**

Run: `npm run test`
Expected: exit 0; the new `autopilot-cards.test.ts` and all existing calibration tests pass.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: exit 0, no warnings on touched files.

- [ ] **Step 4: Build (includes browser-artifact scan)**

Run: `npm run build`
Expected: exit 0; `scripts/verify-client-bundle.mjs` passes (no forbidden markers in the new copy — the strings "Calderyn spotted these…", "Why:", "Do it", "Not now", "Keeps"/"Earns", "sure" are all product copy, no provenance).

- [ ] **Step 5: Manual visual check**

Load the dashboard Autopilot tab on a store that is mid-calibration (`calibrationPct` between 0 and 100 with a non-empty `actionQueue` — use the seeded demo store per the local dev recipe). Confirm for each pending proposal:
- Headline reads as an action (e.g. "Pause money-losing campaigns"); subject line shows the product/campaign.
- "Why:" line shows a plain category; narrative follows when present, category-only when not.
- Dollar line reads "Keeps ~$X" or "Earns ~$X"; absent when impact is 0.
- Primary button reads "Do it" for one-click kinds, "Review" otherwise; shows "Doing…" while in flight.
- "Not now" expands the reject-reason chips; approve and reject still train and refresh the queue.

- [ ] **Step 6: Finish the branch**

Use `superpowers:finishing-a-development-branch` to choose merge/PR. Do not push or open a PR without explicit user request (repo rule).

---

## Notes for the implementer

- The reject panel block (`{rejecting === p.alertId && (...)}`) is intentionally left as-is in Task 3 — it already works and its `id`/`aria-controls` wiring matches the "Not now" button. Only restyle it later if the card visually demands it; not required for this feature.
- Do not touch `LiveEnginePanel`, `AutopilotFeatures`, or any `.server.ts` file. If you find yourself editing a view-model or query, stop — the scope is presentation only.
- `featureLabel` already falls back to `ACTION_LABELS[actionKind]` then the raw kind, so an unmapped action still renders sensibly; no extra guard needed.
- **Deferred (spec deviation):** the design doc's point 7 called for `always_ask` / `over_autopilot_cap` badges. Those flags exist only on the server `QueueProposal`, not on the client `QueueProposalVM`, so surfacing them needs a VM field + mapper change — a data-contract change the spec's own scope forbids. Badges are therefore out of scope for this feature; add them in a follow-up that also plumbs the flags through the VM.
