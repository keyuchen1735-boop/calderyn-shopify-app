# Autopilot Live Action Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the expanded Autopilot calibration queue with a real-data action stream, static expanded review list, percentage gauge, and dollars-at-risk summary.

**Architecture:** Keep all behavior inside the existing `CalibrationTrainer` and reuse its action handlers. A small pure helper selects the rotating four-action window; React state controls the exit/entry phase and expanded modal, while Calderyn CSS handles motion and reduced-motion behavior.

**Tech Stack:** React 18, TypeScript, Vitest/jsdom, existing Calderyn `cd-*` CSS and `TickGauge`.

## Global Constraints

- Use only real `app.actionQueue` entries; never fabricate or duplicate a recommendation.
- Use existing Calderyn theme tokens, buttons, icons, modal treatment, and `TickGauge`.
- Show only calibration percentage and dollars at risk in the summary graphic.
- Add no dependency, route, API, loader, server change, or chart library.
- Leave the graduated Live Engine panel and Autopilot feature switchboard unchanged.

---

### Task 1: Lock the rotating real-action window

**Files:**
- Modify: `app/components/dashboard/screens/Autopilot.tsx`
- Create: `app/components/dashboard/__tests__/autopilot-action-stream.test.tsx`

**Interfaces:**
- Consumes: `readonly T[]`, zero-based start index, visible count.
- Produces: `actionStreamWindow<T>(items: readonly T[], start: number, size: number): T[]`.

- [ ] **Step 1: Write the failing helper test**

```tsx
import { describe, expect, it } from "vitest";
import { actionStreamWindow } from "../screens/Autopilot";

describe("actionStreamWindow", () => {
  it("wraps only real queued actions so the next item can enter at the top", () => {
    const queue = ["a", "b", "c", "d", "e"];
    expect(actionStreamWindow(queue, 0, 4)).toEqual(["a", "b", "c", "d"]);
    expect(actionStreamWindow(queue, -1, 4)).toEqual(["e", "a", "b", "c"]);
    expect(actionStreamWindow(queue, 2, 9)).toEqual(["c", "d", "e", "a", "b"]);
  });

  it("returns an empty window for an empty queue", () => {
    expect(actionStreamWindow([], 4, 4)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and verify the missing export fails**

Run: `npx vitest run app/components/dashboard/__tests__/autopilot-action-stream.test.tsx`

Expected: FAIL because `actionStreamWindow` is not exported.

- [ ] **Step 3: Add the minimum pure helper**

```tsx
export function actionStreamWindow<T>(items: readonly T[], start: number, size: number): T[] {
  if (items.length === 0 || size <= 0) return [];
  const first = ((start % items.length) + items.length) % items.length;
  return Array.from(
    { length: Math.min(size, items.length) },
    (_, index) => items[(first + index) % items.length],
  );
}
```

- [ ] **Step 4: Run the focused test**

Run: `npx vitest run app/components/dashboard/__tests__/autopilot-action-stream.test.tsx`

Expected: PASS.

### Task 2: Replace the expanded queue with the live stream and static modal

**Files:**
- Modify: `app/components/dashboard/screens/Autopilot.tsx`
- Modify: `app/styles/dashboard.css`
- Test: `app/components/dashboard/__tests__/autopilot-action-stream.test.tsx`

**Interfaces:**
- Consumes: `app.actionQueue`, `liveEngine.calibrationPct`, existing `approve`, `reject`, `approveAll`, and `onReview` handlers.
- Produces: `.cd-ap-stream`, `.cd-ap-stream-row`, `.cd-ap-stream-modal`, and the accessible `Expand all actions` dialog.

- [ ] **Step 1: Add a failing DOM contract test**

Add a jsdom test that renders the exported `CalibrationTrainer` with five proposals and fake timers, then asserts:

```tsx
expect(host.querySelectorAll(".cd-ap-stream-row")).toHaveLength(4);
expect(host.textContent).toContain("46%");
expect(host.textContent).toContain("$4.8K");

act(() => vi.advanceTimersByTime(3_600));
expect(host.querySelector(".cd-ap-stream-row")?.getAttribute("data-alert-id")).toBe("alert-5");

act(() => host.querySelector<HTMLButtonElement>("[aria-label='Expand all actions']")?.click());
expect(host.querySelector("[role='dialog']")?.textContent).toContain("All waiting actions");
expect(host.querySelectorAll(".cd-ap-stream-static-row")).toHaveLength(5);
```

Use real-shaped `QueueProposalVM` values and a minimal `DashboardCtx` test double containing `actionQueue`, `alerts`, `executeAction`, `refresh`, `toast`, and `navigate`.

- [ ] **Step 2: Run the DOM test and verify the old expanded queue fails the contract**

Run: `npx vitest run app/components/dashboard/__tests__/autopilot-action-stream.test.tsx`

Expected: FAIL because the stream, summary, and dialog do not exist.

- [ ] **Step 3: Implement the stream state and truthful KPI summary**

Inside `CalibrationTrainer`, add only these states and derived values:

```tsx
const STREAM_SIZE = 4;
const STREAM_INTERVAL_MS = 3_200;
const STREAM_EXIT_MS = 360;

const [streamStart, setStreamStart] = useState(0);
const [streamExiting, setStreamExiting] = useState(false);
const [showAll, setShowAll] = useState(false);
const visibleQueue = actionStreamWindow(queue, streamStart, STREAM_SIZE);
```

Use one effect that pauses when the queue fits, the modal is open, a decision is busy, or the document is hidden. On each interval, mark the bottom row exiting, then decrement `streamStart` after `STREAM_EXIT_MS` so the next real action becomes the top row. Clean up both timers.

Render the left rail as:

```tsx
<div className="cd-ap-stream-kpis">
  <TickGauge pct={pct} size={176} />
  <span className="cd-ap-stream-calibrated">calibrated</span>
  <div className="cd-ap-stream-risk">
    <b className="tabular-nums">{moneyK(atStake)}</b>
    <span>dollars at risk across waiting actions</span>
  </div>
</div>
```

Render `visibleQueue` with the existing action-row controls inside `.cd-ap-stream`; add `data-alert-id`, mark the first row as entering after rotation, and mark the last row while `streamExiting`.

Render `showAll` with the existing `.cd-modal-overlay` and `.cd-card` treatment, `role="dialog"`, `aria-modal="true"`, the two KPIs, and every grouped queue action as `.cd-ap-stream-static-row`. Closing the modal resumes rotation.

- [ ] **Step 4: Add Calderyn-token motion and reduced-motion CSS**

Add scoped rules using only existing variables:

```css
@keyframes cd-ap-stream-enter {
  0% { opacity: 0; transform: translate3d(240px, -96px, 0) rotate(6deg) scale(.72); }
  58% { opacity: 1; transform: translate3d(-10px, 5px, 0) rotate(-1deg) scale(1.035); }
  100% { opacity: 1; transform: none; }
}
.cd-ap-stream-row[data-entering="1"] {
  animation: cd-ap-stream-enter .78s cubic-bezier(.16, 1.22, .32, 1) both;
}
.cd-ap-stream-row[data-exiting="1"] {
  opacity: 0;
  transform: translate3d(18px, 78px, 0) scale(.92);
}
@media (prefers-reduced-motion: reduce) {
  .cd-ap-stream-row { animation: none !important; transition: none !important; }
}
```

- [ ] **Step 5: Run the focused test and touched-file lint**

Run: `npx vitest run app/components/dashboard/__tests__/autopilot-action-stream.test.tsx`

Expected: PASS.

Run: `npx eslint --max-warnings=0 app/components/dashboard/screens/Autopilot.tsx app/components/dashboard/__tests__/autopilot-action-stream.test.tsx`

Expected: exit 0 with no warnings.

### Task 3: Verify, preview, and release

**Files:**
- Verify: `app/components/dashboard/screens/Autopilot.tsx`
- Verify: `app/components/dashboard/__tests__/autopilot-action-stream.test.tsx`
- Verify: `app/styles/dashboard.css`

**Interfaces:**
- Consumes: completed Tasks 1 and 2.
- Produces: one reviewed commit, pull request, merged deployment, and production evidence.

- [ ] **Step 1: Run repository gates in required order**

Run:

```bash
npm run typecheck
npm run lint
npm run build
```

Expected: all commands exit 0; build runs client-bundle verification.

- [ ] **Step 2: Run patch sanity and inspect the browser preview**

Run:

```bash
git diff --check
git diff --stat
rg -n "console\.log|\.only\(|TODO\(me\)|Claude|ChatGPT|vibecod" app/components/dashboard/screens/Autopilot.tsx app/components/dashboard/__tests__/autopilot-action-stream.test.tsx app/styles/dashboard.css
```

Expected: clean diff checks and no introduced browser-visible provenance or debug markers.

Start the Remix Vite preview, open `/dashboard/autopilot`, and verify top entry, bottom exit, percentage and risk refresh, reduced motion, modal pause, and static list.

- [ ] **Step 3: Commit, push, open the PR, and merge after green checks**

```bash
git add app/components/dashboard/screens/Autopilot.tsx app/components/dashboard/__tests__/autopilot-action-stream.test.tsx app/styles/dashboard.css docs/superpowers/plans/2026-07-16-autopilot-live-action-stream.md
git commit -m "dashboard/Autopilot: add live action stream"
git push -u origin feat/autopilot-collapse
gh pr create --fill
```

Verify review and checks, merge the PR, and confirm the Vercel deployment is Ready.

- [ ] **Step 4: Verify production**

Open `https://calderyncompany.com/dashboard/autopilot` and verify the deployed build serves successfully. Confirm the merged commit is present in the production deployment before reporting completion.
