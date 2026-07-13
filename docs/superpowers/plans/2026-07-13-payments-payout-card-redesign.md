# Payments Payout Card Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Payments screen's prose-heavy payout section with a concise, responsive bank-card visual that prioritizes available and pending balances after onboarding.

**Architecture:** Keep `PayoutsCard` as the data/action owner and extract an exported, pure `PayoutPanel` renderer in the same module so all visual states can be server-rendered in tests. Add a single isolated `cd-payout-*` CSS block to the existing dashboard stylesheet; no API, view-model, dependency, or shared-primitive changes are required.

**Tech Stack:** React 18, TypeScript, Remix, Vitest, `react-dom/server`, dashboard CSS tokens and shared `Btn` primitive.

## Global Constraints

- Prioritize the everyday active-payout view after Stripe onboarding.
- Use only existing `BillingStatus` data: available balance, pending balance, status flags, and fee label.
- Do not fabricate bank identity, account digits, payout dates, or historical trends.
- Build the decorative bank card in CSS and mark it `aria-hidden="true"`.
- Preserve current Stripe onboarding, login-link, refresh, retry, and toast behavior.
- Add no dependency and do not alter backend/API behavior.
- Append isolated `cd-payout-*` styles without rewriting unrelated user edits already present in `app/styles/dashboard.css`.
- Stack the panel at the phone breakpoint and honor `prefers-reduced-motion`.

---

## File map

- Modify `app/components/dashboard/PayoutsCard.tsx`: split the pure visual renderer from the existing side-effect owner and render active, onboarding, loading, and error states.
- Modify `app/components/dashboard/__tests__/payouts-card.test.ts`: preserve view-model tests and add server-rendered visual-state coverage.
- Modify `app/styles/dashboard.css`: append the isolated bank-card panel, responsive layout, focus, skeleton, theme, and reduced-motion rules.

### Task 1: Lock the payout panel's visual-state contract with failing tests

**Files:**
- Modify: `app/components/dashboard/__tests__/payouts-card.test.ts`
- Test: `app/components/dashboard/__tests__/payouts-card.test.ts`

**Interfaces:**
- Consumes: existing `BillingStatus` and `DashboardCtx` types.
- Produces: an expected exported component named `PayoutPanel` with props `{ billing, loadFailed, busy, onRetryLoad, onCta, onOpenStripe, onRefresh }`.

- [ ] **Step 1: Add static-render helpers and visual-state assertions**

Append imports and fixtures that render the pure panel without running effects:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { PayoutPanel } from "../PayoutsCard";
import type { BillingStatus } from "~/lib/dashboard/client";

const ACTIVE: BillingStatus = {
  connected: true,
  chargesEnabled: true,
  payoutsEnabled: true,
  detailsSubmitted: true,
  feeBps: 0,
  feeFlatCents: 0,
  balance: {
    available: [{ amountCents: 1_284_072, currency: "usd" }],
    pending: [{ amountCents: 192_640, currency: "usd" }],
  },
};

const actions = {
  onRetryLoad: () => {},
  onCta: () => {},
  onOpenStripe: () => {},
  onRefresh: () => {},
};

function renderPanel(
  billing: BillingStatus | null,
  options: { loadFailed?: boolean; busy?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <PayoutPanel
      billing={billing}
      loadFailed={options.loadFailed ?? false}
      busy={options.busy ?? false}
      {...actions}
    />,
  );
}

describe("PayoutPanel", () => {
  it("prioritizes balances and Stripe actions in the active state", () => {
    const html = renderPanel(ACTIVE);
    expect(html).toContain('data-phase="active"');
    expect(html).toContain("$12,840.72");
    expect(html).toContain("$1,926.40");
    expect(html).toContain("Open Stripe");
    expect(html).toContain("Refresh");
    expect(html).toContain('aria-hidden="true"');
  });

  it("shows an em dash instead of treating a missing balance as zero", () => {
    const html = renderPanel({ ...ACTIVE, balance: null });
    expect(html).toContain("cd-payout-amount");
    expect(html).toContain(">—<");
  });

  it("reduces incomplete onboarding to one message and one CTA", () => {
    const html = renderPanel({
      ...ACTIVE,
      payoutsEnabled: false,
      detailsSubmitted: false,
      balance: null,
    });
    expect(html).toContain('data-phase="onboarding"');
    expect(html).toContain("Finish payout setup");
    expect(html).toContain("Resume onboarding");
    expect(html).not.toContain("Open Stripe");
  });

  it("renders a shaped loading state", () => {
    const html = renderPanel(null);
    expect(html).toContain('data-phase="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("cd-payout-skeleton");
  });

  it("keeps load failures inline with a retry action", () => {
    const html = renderPanel(null, { loadFailed: true });
    expect(html).toContain('data-phase="error"');
    expect(html).toContain("Payout status unavailable");
    expect(html).toContain("Retry");
  });
});
```

- [ ] **Step 2: Run the focused test and verify the new contract fails**

Run: `npm test -- app/components/dashboard/__tests__/payouts-card.test.ts`

Expected: FAIL because `PayoutPanel` is not exported by `PayoutsCard.tsx`.

- [ ] **Step 3: Commit the red test**

```bash
git add app/components/dashboard/__tests__/payouts-card.test.ts
git commit -m "test: define graphic payout panel states"
```

### Task 2: Implement the pure payout renderer and preserve existing actions

**Files:**
- Modify: `app/components/dashboard/PayoutsCard.tsx`
- Test: `app/components/dashboard/__tests__/payouts-card.test.ts`

**Interfaces:**
- Consumes: `BillingStatus`, `payoutsCardState`, `money`, and the shared `Btn` primitive.
- Produces: exported `PayoutPanel(props: PayoutPanelProps)`; `PayoutsCard` delegates rendering to it while retaining all current effects and handlers.

- [ ] **Step 1: Replace the old card markup with a pure state renderer**

Change the UI import to `import { Btn } from "./ui";`, define the prop interface, and add:

```tsx
interface PayoutPanelProps {
  billing: BillingStatus | null;
  loadFailed: boolean;
  busy: boolean;
  onRetryLoad: () => void;
  onCta: () => void;
  onOpenStripe: () => void;
  onRefresh: () => void;
}

export function PayoutPanel({
  billing,
  loadFailed,
  busy,
  onRetryLoad,
  onCta,
  onOpenStripe,
  onRefresh,
}: PayoutPanelProps) {
  const vm = billing ? payoutsCardState(billing) : null;
  const phase = loadFailed ? "error" : vm?.phase ?? "loading";
  const active = vm?.phase === "active";
  const available = billing?.balance?.available?.[0];
  const pending = billing?.balance?.pending?.[0];
  const feeValue = vm?.feeLabel.replace(/^Platform fee:\s*/, "") ?? "—";

  return (
    <section className="cd-payout-section" aria-labelledby="cd-payout-title">
      <div
        className="cd-payout-panel"
        data-phase={phase}
        aria-busy={phase === "loading" ? "true" : undefined}
      >
        <div className="cd-payout-visual">
          <div className="cd-payout-head">
            <h2 id="cd-payout-title" className="cd-payout-title">Payouts</h2>
            {vm && (
              <span className="cd-payout-status" data-tone={vm.pillTone}>
                <i aria-hidden="true" />{vm.pillLabel}
              </span>
            )}
          </div>

          {phase === "loading" ? (
            <div className="cd-payout-skeleton cd-payout-skeleton--amount" />
          ) : active ? (
            <div className="cd-payout-balance">
              <span>Available balance</span>
              <strong className="cd-payout-amount tabular-nums">
                {available ? money(available.amountCents) : "—"}
              </strong>
            </div>
          ) : (
            <div className="cd-payout-balance cd-payout-balance--setup">
              <span>Stripe Connect</span>
              <strong>Money routed to your bank</strong>
            </div>
          )}

          <div className="cd-payout-card-art" aria-hidden="true">
            <span className="cd-payout-card-chip" />
            <span className="cd-payout-card-mark">PAYOUT</span>
            <span className="cd-payout-card-lines"><i /><i /></span>
          </div>
        </div>

        <div className="cd-payout-details">
          {phase === "loading" ? (
            <>
              <div className="cd-payout-skeleton cd-payout-skeleton--row" />
              <div className="cd-payout-skeleton cd-payout-skeleton--row" />
              <div className="cd-payout-skeleton cd-payout-skeleton--button" />
            </>
          ) : phase === "error" ? (
            <div className="cd-payout-state-copy">
              <h3>Payout status unavailable</h3>
              <p>We couldn't read your Stripe payout status just now.</p>
              <Btn onClick={onRetryLoad}>Retry</Btn>
            </div>
          ) : active ? (
            <>
              <div className="cd-payout-detail-row">
                <span>Pending</span>
                <strong className="tabular-nums">
                  {pending ? money(pending.amountCents) : "—"}
                </strong>
              </div>
              <div className="cd-payout-detail-row">
                <span>Platform fee</span><strong>{feeValue}</strong>
              </div>
              <div className="cd-payout-actions">
                <Btn kind="primary" onClick={onOpenStripe} disabled={busy}>
                  Open Stripe <span aria-hidden="true">↗</span>
                </Btn>
                <button
                  type="button"
                  className="cd-payout-refresh"
                  onClick={onRefresh}
                  disabled={busy}
                  aria-label="Refresh payout status"
                >
                  <span aria-hidden="true">↻</span> Refresh
                </button>
              </div>
            </>
          ) : (
            <div className="cd-payout-state-copy">
              <h3>Finish payout setup</h3>
              <p>
                {vm?.phase === "onboarding"
                  ? "Complete Stripe onboarding to send buyer payments to your bank."
                  : "Connect Stripe so buyer payments can land in your bank automatically."}
              </p>
              <span className="cd-payout-fee">{vm?.feeLabel}</span>
              <Btn kind="primary" onClick={onCta} disabled={busy}>
                {vm?.cta === "setup" ? "Set up payouts" : "Resume onboarding"}
              </Btn>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Delegate from the stateful wrapper**

Remove the old `vm`, `available`, `pending`, `SectionTitle`, `Card`, and `Pill` rendering block. Keep all effects and handlers unchanged, then return:

```tsx
return (
  <PayoutPanel
    billing={billing}
    loadFailed={loadFailed}
    busy={busy}
    onRetryLoad={onRetryLoad}
    onCta={onCta}
    onOpenStripe={onOpenStripe}
    onRefresh={onRefresh}
  />
);
```

- [ ] **Step 3: Run the focused test and verify behavior passes**

Run: `npm test -- app/components/dashboard/__tests__/payouts-card.test.ts`

Expected: all view-model and `PayoutPanel` tests PASS.

- [ ] **Step 4: Run type checking**

Run: `npm run typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Commit the renderer**

```bash
git add app/components/dashboard/PayoutsCard.tsx app/components/dashboard/__tests__/payouts-card.test.ts
git commit -m "feat: restructure payouts around everyday balances"
```

### Task 3: Apply the production bank-card visual and responsive layout

**Files:**
- Modify: `app/styles/dashboard.css`
- Test: `app/components/dashboard/__tests__/payouts-card.test.ts`

**Interfaces:**
- Consumes: the `cd-payout-*` DOM contract from Task 2 and existing dashboard theme tokens.
- Produces: a two-column desktop panel, stacked phone layout, CSS-only 3D card, skeleton, focus states, dark-theme compatibility, and reduced-motion behavior.

- [ ] **Step 1: Append one isolated payout stylesheet block**

Append a `/* ============ Payments: payouts ============ */` block that defines:

```css
.cd-payout-section { display: block; }
.cd-payout-panel { display: grid; grid-template-columns: minmax(0, 1.12fr) minmax(280px, .88fr); min-height: 286px; overflow: hidden; border-radius: 20px; background: var(--card-solid); box-shadow: var(--shadow-card); }
.cd-payout-visual { position: relative; min-width: 0; overflow: hidden; padding: 24px 26px 26px; color: #f5f5f2; background: radial-gradient(100% 130% at 100% 0%, rgba(255,255,255,.13), transparent 54%), linear-gradient(145deg, #2d2d30 0%, #18181b 58%, #101012 100%); }
.cd-payout-head { position: relative; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.cd-payout-title { margin: 0; font-size: calc(15px * var(--type-scale)); font-weight: 640; letter-spacing: -.012em; color: inherit; }
.cd-payout-status { display: inline-flex; align-items: center; gap: 7px; color: rgba(255,255,255,.68); font-size: calc(11px * var(--type-scale)); font-weight: 590; }
.cd-payout-status i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 4px rgba(255,255,255,.08); }
.cd-payout-status[data-tone="success"] { color: #8fd7a7; }
.cd-payout-status[data-tone="warn"] { color: #efc477; }
.cd-payout-balance { position: relative; z-index: 2; display: flex; flex-direction: column; margin-top: 55px; }
.cd-payout-balance > span { color: rgba(255,255,255,.53); font-size: calc(11.5px * var(--type-scale)); font-weight: 520; }
.cd-payout-amount { margin-top: 7px; color: #fff; font-family: "SF Pro Display", -apple-system, BlinkMacSystemFont, sans-serif; font-size: clamp(34px, 4.3vw, 48px); font-weight: 670; line-height: 1; letter-spacing: -.045em; }
.cd-payout-balance--setup { max-width: 250px; }
.cd-payout-balance--setup strong { margin-top: 7px; font-size: calc(24px * var(--type-scale)); line-height: 1.04; letter-spacing: -.035em; text-wrap: balance; }
.cd-payout-card-art { position: absolute; right: 24px; bottom: -10px; width: 150px; aspect-ratio: 1.58; border-radius: 15px; background: linear-gradient(135deg, #66666a, #303034 52%, #171719); box-shadow: 20px 27px 34px -20px rgba(0,0,0,.9), inset 0 0 0 1px rgba(255,255,255,.15); transform: perspective(430px) rotateX(13deg) rotateY(-17deg) rotateZ(-2deg); transition: transform .35s cubic-bezier(.22,.8,.24,1); }
.cd-payout-panel:hover .cd-payout-card-art { transform: perspective(430px) rotateX(7deg) rotateY(-9deg) translateY(-3px); }
.cd-payout-card-chip { position: absolute; left: 18px; top: 24px; width: 26px; height: 19px; border-radius: 4px; background: linear-gradient(180deg, #eadc9e, #b59442); box-shadow: inset 0 0 0 1px rgba(62,49,12,.2); }
.cd-payout-card-mark { position: absolute; right: 16px; top: 16px; color: rgba(255,255,255,.54); font: 650 8px/1 ui-monospace, monospace; letter-spacing: .12em; }
.cd-payout-card-lines { position: absolute; right: 16px; bottom: 15px; display: flex; flex-direction: column; gap: 5px; align-items: flex-end; }
.cd-payout-card-lines i { display: block; width: 42px; height: 3px; border-radius: 9px; background: rgba(255,255,255,.42); }
.cd-payout-card-lines i:last-child { width: 27px; opacity: .58; }
.cd-payout-details { display: flex; flex-direction: column; justify-content: center; min-width: 0; padding: 25px 26px; }
.cd-payout-detail-row { display: flex; align-items: baseline; justify-content: space-between; gap: 20px; padding: 17px 0; border-bottom: .5px solid var(--hairline-strong); }
.cd-payout-detail-row:first-child { border-top: .5px solid var(--hairline-strong); }
.cd-payout-detail-row span { color: var(--text-2); font-size: calc(12.5px * var(--type-scale)); }
.cd-payout-detail-row strong { color: var(--text-1); font-size: calc(14px * var(--type-scale)); font-weight: 630; }
.cd-payout-actions { display: flex; align-items: center; gap: 9px; margin-top: 22px; }
.cd-payout-refresh { display: inline-flex; align-items: center; gap: 6px; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--text-2); font-family: inherit; font-size: calc(12px * var(--type-scale)); font-weight: 560; line-height: 1; cursor: pointer; transition: color .16s ease, background .16s ease, transform .16s ease; }
.cd-payout-refresh:hover { color: var(--text-1); background: var(--gray-bg); }
.cd-payout-refresh:active { transform: scale(.97); }
.cd-payout-refresh:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.cd-payout-refresh:disabled { opacity: .4; pointer-events: none; }
.cd-payout-state-copy { display: flex; flex-direction: column; align-items: flex-start; }
.cd-payout-state-copy h3 { margin: 0; color: var(--text-1); font-size: calc(18px * var(--type-scale)); font-weight: 640; letter-spacing: -.018em; }
.cd-payout-state-copy p { max-width: 38ch; margin: 7px 0 17px; color: var(--text-2); font-size: calc(13px * var(--type-scale)); line-height: 1.45; text-wrap: pretty; }
.cd-payout-fee { margin: -7px 0 18px; color: var(--text-3); font-size: calc(11.5px * var(--type-scale)); }
.cd-payout-panel[data-phase="loading"] .cd-payout-card-art, .cd-payout-panel[data-phase="error"] .cd-payout-card-art, .cd-payout-panel[data-phase="not_connected"] .cd-payout-card-art, .cd-payout-panel[data-phase="onboarding"] .cd-payout-card-art { opacity: .52; filter: saturate(.55); }
.cd-payout-skeleton { overflow: hidden; border-radius: 8px; background: var(--gray-bg); background-image: linear-gradient(90deg, transparent, rgba(255,255,255,.36), transparent); background-size: 200% 100%; animation: cd-payout-shimmer 1.4s ease-in-out infinite; }
.cd-payout-visual .cd-payout-skeleton { background-color: rgba(255,255,255,.09); background-image: linear-gradient(90deg, transparent, rgba(255,255,255,.11), transparent); }
.cd-payout-skeleton--amount { position: relative; z-index: 2; width: 58%; height: 44px; margin-top: 67px; }
.cd-payout-skeleton--row { height: 45px; margin-bottom: 12px; }
.cd-payout-skeleton--button { width: 132px; height: 34px; margin-top: 9px; }
@keyframes cd-payout-shimmer { from { background-position: 180% 0; } to { background-position: -20% 0; } }

@media (max-width: 767px) {
  .cd-payout-panel { grid-template-columns: 1fr; min-height: 0; }
  .cd-payout-visual { min-height: 250px; padding: 20px; }
  .cd-payout-balance { margin-top: 42px; }
  .cd-payout-card-art { right: 18px; width: 132px; }
  .cd-payout-details { padding: 21px 20px 23px; }
  .cd-payout-actions { flex-wrap: wrap; }
}

@media (max-width: 420px) {
  .cd-payout-card-art { right: -22px; opacity: .76; }
  .cd-payout-amount { font-size: 34px; }
}

@media (prefers-reduced-motion: reduce) {
  .cd-payout-card-art, .cd-payout-panel:hover .cd-payout-card-art { transition: none; transform: perspective(430px) rotateX(13deg) rotateY(-17deg) rotateZ(-2deg); }
  .cd-payout-skeleton { animation: none; }
}
```

- [ ] **Step 2: Run targeted checks**

Run:

```bash
npm test -- app/components/dashboard/__tests__/payouts-card.test.ts
npm run typecheck
git diff --check
```

Expected: tests and type checking PASS; `git diff --check` prints no whitespace errors.

- [ ] **Step 3: Inspect desktop and phone layouts in light and dark themes**

Run the existing app locally, open Payments, and verify at approximately 1020px and 390px content widths:

- active view shows the dominant available balance and unobstructed card art;
- onboarding shows one message and one CTA;
- actions remain keyboard-focusable and tappable;
- text remains legible in both themes;
- no horizontal overflow occurs.

Expected: all five visual checks pass without modifying unrelated dashboard rules.

- [ ] **Step 4: Commit the production styling**

```bash
git add app/styles/dashboard.css
git commit -m "style: add graphic bank-card payout panel"
```

### Task 4: Run the release verification gate

**Files:**
- Verify: `app/components/dashboard/PayoutsCard.tsx`
- Verify: `app/components/dashboard/__tests__/payouts-card.test.ts`
- Verify: `app/styles/dashboard.css`

**Interfaces:**
- Consumes: completed component and CSS changes.
- Produces: a production-ready verified payout redesign.

- [ ] **Step 1: Run the full relevant automated gate**

Run:

```bash
npm test -- app/components/dashboard/__tests__/payouts-card.test.ts app/routes/__tests__/dashboard.api.billing.test.ts app/routes/__tests__/dashboard.payouts.stripe.test.ts
npm run typecheck
npm run build
```

Expected: all targeted payout/API tests PASS, type checking PASS, and the production Remix build PASS including the client-bundle verification step.

- [ ] **Step 2: Review only the payout diff and confirm workspace isolation**

Run:

```bash
git diff --check HEAD~2..HEAD
git show --stat --oneline HEAD~2..HEAD
git status --short
```

Expected: implementation commits contain only the payout component, payout tests, and the appended CSS block; pre-existing unrelated workspace changes remain uncommitted and untouched.
