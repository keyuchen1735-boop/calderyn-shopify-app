# Payment-gate Test Transaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a `dual_run` merchant a one-click "Run a test transaction" button that originates a real 50¢ Stripe charge, turning the `paid_order` + `captured_charge` go-live gates green, then auto-refunds it when cutover commits.

**Architecture:** Reuse-first. A minimal owned `orders` row tagged `channel='test'` (no cart, no variant, no inventory) is handed to the existing `createCommerceCheckoutSession`. The existing Stripe webhook (`processStripeEvent`) flips it `paid` and writes the `capture` ledger row — so both gate checks pass with zero new payment logic. A cleanup sweep hooked into `transitionOrgMode`'s post-commit path full-refunds every paid test order after `→ live` succeeds.

**Tech Stack:** Remix (Vite) + TypeScript, Supabase Postgres, Stripe, Vitest.

---

## Context the implementer needs

- **The money path is already automatic.** `app/lib/payments/stripe.server.ts:processStripeEvent` keys off `pi.metadata.order_ref`; on `payment_intent.succeeded` it transitions the order to `paid` and records a `transaction_ledger` row with `kind='capture'` (line ~130, `p_kind: "capture"`). It does NOT read order line items — a line-less probe order works.
- **The gate counts, verbatim** (`app/lib/cutover/go-live.server.ts:191-192`): `paid_order` = `count(orders where state='paid')`, `captured_charge` = `count(transaction_ledger where kind='capture')`. No gate changes in this plan.
- **`orders.channel`** already exists — `text NOT NULL default 'storefront'`, app-level vocabulary (migration `20260630120000_agentic_order_channel.sql`). **No new migration.**
- **Stripe minimum charge is $0.50 USD.** Charges below the per-currency minimum are rejected. The probe charges **50 cents USD**.
- **Reusable functions (exact signatures):**
  - `createCommerceCheckoutSession(shopId: string, input: { orderId: string; totalCents: number; currency: string; confirmationToken: string }): Promise<{ sessionId: string; url: string }>` — `app/lib/commerce/stripe-checkout.server.ts`
  - `getConnectedAccount(shopId: string): Promise<ConnectedAccountRow | null>` — `app/lib/payments/connect.server.ts` (null = Stripe not connected)
  - `executeRefundAction(shopId: string, input: RefundActionInput, sb: SupabaseClient, deps?: RefundDeps): Promise<RefundActionResult>` — `app/lib/actions/refund.server.ts`. `RefundActionInput = { orderId; amountCents?; idempotencyKey; actor?; triggerReason?; reason? }`. Omitting `amountCents` refunds the FULL remaining. Refund moves the order `paid → refunded`.
  - `getOrgMode(shopId): Promise<OrgMode>` — `app/lib/cutover/org-mode.server.ts`
  - `getSupabase()` — `app/lib/supabase.server.ts`
- **Test runner:** `npx vitest run <path>`; typecheck `npm run typecheck`.
- **Server-file rule:** anything importing Supabase/Stripe must end in `.server.ts`.

## File structure

- **Create** `app/lib/cutover/test-transaction.server.ts` — `startTestTransaction` (originate probe) + `refundTestOrders` (cleanup sweep). Both are cutover-scoped money-path helpers, one responsibility (the go-live payment probe lifecycle), so they live together.
- **Create** `app/lib/cutover/__tests__/test-transaction.server.test.ts` — unit tests for both.
- **Modify** `app/lib/cutover/org-mode.server.ts` — call `refundTestOrders` in the post-`→ live`-commit block.
- **Create** `app/routes/dashboard.api.cutover-test-transaction.tsx` — POST route returning `{ url }`.
- **Modify** `app/lib/dashboard/client.ts` — add `startTestTransaction()` client fn.
- **Modify** `app/components/dashboard/screens/Cutover.tsx` — "Run a test transaction" button under the payment checks.

## Descoped (flagged deviation from spec component 6)

Analytics exclusion of `channel='test'` is **not implemented**. The probe is refunded to `refunded` state at cutover (revenue nets to zero), exists only transiently during pre-launch `dual_run`, and a visible refunded 50¢ test order is honest audit trail. If hiding is wanted later, add `.neq("channel", "test")` to the three order reads: `app/lib/dashboard/live-analytics.server.ts:86`, `app/lib/analytics/commerce.server.ts:89` and `:186`.

---

### Task 1: `startTestTransaction` — originate the 50¢ probe

**Files:**
- Create: `app/lib/cutover/test-transaction.server.ts`
- Test: `app/lib/cutover/__tests__/test-transaction.server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/cutover/__tests__/test-transaction.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  getOrgMode: vi.fn(),
  getConnectedAccount: vi.fn(),
  createCommerceCheckoutSession: vi.fn(),
  upsertGuestBuyer: vi.fn(),
  insertReturn: vi.fn(),
}));

vi.mock("~/lib/cutover/org-mode.server", () => ({ getOrgMode: hoisted.getOrgMode }));
vi.mock("~/lib/payments/connect.server", () => ({ getConnectedAccount: hoisted.getConnectedAccount }));
vi.mock("~/lib/commerce/stripe-checkout.server", () => ({
  createCommerceCheckoutSession: hoisted.createCommerceCheckoutSession,
}));
vi.mock("~/lib/buyer/identity.server", () => ({ upsertGuestBuyer: hoisted.upsertGuestBuyer }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      insert: () => ({ select: () => ({ single: hoisted.insertReturn }) }),
    }),
  }),
}));

import { startTestTransaction, TEST_CHARGE_CENTS } from "../test-transaction.server";

describe("startTestTransaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getOrgMode.mockResolvedValue("dual_run");
    hoisted.getConnectedAccount.mockResolvedValue({ id: "acct_1" });
    hoisted.upsertGuestBuyer.mockResolvedValue({ id: "buyer-1" });
    hoisted.insertReturn.mockResolvedValue({
      data: { id: "order-123", confirmation_token: "tok-abc" },
      error: null,
    });
    hoisted.createCommerceCheckoutSession.mockResolvedValue({ sessionId: "cs_1", url: "https://stripe/pay" });
  });

  it("originates a channel='test' order at the Stripe minimum and returns the checkout url", async () => {
    const res = await startTestTransaction("shop-1");
    expect(res.url).toBe("https://stripe/pay");
    expect(TEST_CHARGE_CENTS).toBe(50);
    expect(hoisted.createCommerceCheckoutSession).toHaveBeenCalledWith("shop-1", {
      orderId: "order-123",
      totalCents: 50,
      currency: "usd",
      confirmationToken: "tok-abc",
    });
  });

  it("rejects when the shop is not in dual_run", async () => {
    hoisted.getOrgMode.mockResolvedValue("mirror");
    await expect(startTestTransaction("shop-1")).rejects.toThrow(/dual_run/);
  });

  it("rejects with a clear message when Stripe is not connected", async () => {
    hoisted.getConnectedAccount.mockResolvedValue(null);
    await expect(startTestTransaction("shop-1")).rejects.toThrow(/Connect Stripe/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/cutover/__tests__/test-transaction.server.test.ts`
Expected: FAIL — `Cannot find module '../test-transaction.server'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/cutover/test-transaction.server.ts
// Go-live payment probe (Step 9). The paid_order + captured_charge gates need a real
// cleared transaction; this originates the smallest one Stripe allows (50c USD) as a
// line-less owned order tagged channel='test', then hands it to the existing checkout
// session + webhook path — no new payment logic. refundTestOrders (below) unwinds it
// after cutover commits.
import { randomBytes } from "node:crypto";
import { getSupabase } from "~/lib/supabase.server";
import { getOrgMode } from "~/lib/cutover/org-mode.server";
import { getConnectedAccount } from "~/lib/payments/connect.server";
import { upsertGuestBuyer } from "~/lib/buyer/identity.server";
import { createCommerceCheckoutSession } from "~/lib/commerce/stripe-checkout.server";

/** Stripe's minimum chargeable amount (USD). ponytail: fixed 50c/usd; per-currency
 *  minimums if a non-USD test store ever needs it. */
export const TEST_CHARGE_CENTS = 50;

export async function startTestTransaction(shopId: string): Promise<{ url: string }> {
  if (!shopId) throw new Error("shopId is required");

  const mode = await getOrgMode(shopId);
  if (mode !== "dual_run") {
    throw new Error(`a test transaction can only be run in dual_run (shop is in ${mode})`);
  }
  if (!(await getConnectedAccount(shopId))) {
    throw new Error("Connect Stripe before running a test transaction.");
  }

  // orders.buyer_id is NOT NULL (order_spine.sql:122) — every money-path order carries a
  // buyer, so the probe reuses the same guest-buyer upsert the storefront checkout uses.
  const buyer = await upsertGuestBuyer(shopId, { email: "test-probe@calderyn.internal" });

  const confirmationToken = randomBytes(32).toString("base64url");
  const { data, error } = await getSupabase()
    .from("orders")
    .insert({
      shop_id: shopId,
      buyer_id: buyer.id,
      channel: "test",
      subtotal_cents: TEST_CHARGE_CENTS,
      shipping_cents: 0,
      tax_cents: 0,
      total_cents: TEST_CHARGE_CENTS,
      currency: "usd",
      confirmation_token: confirmationToken,
      // state defaults to 'checkout_pending'; no lines, no inventory reserved.
    })
    .select("id, confirmation_token")
    .single();
  if (error) throw error;
  const row = data as { id: string; confirmation_token: string };

  const session = await createCommerceCheckoutSession(shopId, {
    orderId: row.id,
    totalCents: TEST_CHARGE_CENTS,
    currency: "usd",
    confirmationToken: row.confirmation_token,
  });
  return { url: session.url };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/cutover/__tests__/test-transaction.server.test.ts`
Expected: PASS (3 tests).

> RESOLVED: `orders.buyer_id` is NOT NULL (`order_spine.sql:122`), so the probe upserts a guest buyer first via `upsertGuestBuyer(shopId, { email }): Promise<Buyer>` from `~/lib/buyer/identity.server` (returns a `Buyer` with `.id`) — already wired into Step 3's code and the Step 1 test mock above.

- [ ] **Step 5: Commit**

```bash
git add app/lib/cutover/test-transaction.server.ts app/lib/cutover/__tests__/test-transaction.server.test.ts
git commit -m "feat(cutover): originate 50c go-live test transaction probe"
```

---

### Task 2: `refundTestOrders` cleanup sweep + hook into cutover

**Files:**
- Modify: `app/lib/cutover/test-transaction.server.ts` (add `refundTestOrders`)
- Modify: `app/lib/cutover/org-mode.server.ts:186-194` (call it after the `→ live` commit)
- Test: `app/lib/cutover/__tests__/test-transaction.server.test.ts` (add cases)

- [ ] **Step 1: Write the failing test** (append to the existing test file)

```ts
// append to app/lib/cutover/__tests__/test-transaction.server.test.ts
import { refundTestOrders } from "../test-transaction.server";

const refundHoisted = vi.hoisted(() => ({
  executeRefundAction: vi.fn(),
  pagedOrders: vi.fn(),
}));
vi.mock("~/lib/actions/refund.server", () => ({ executeRefundAction: refundHoisted.executeRefundAction }));

describe("refundTestOrders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refundHoisted.pagedOrders.mockResolvedValue([{ id: "o1" }, { id: "o2" }]);
    refundHoisted.executeRefundAction.mockResolvedValue({ outcome: "succeeded" });
  });

  // Supabase seam: getSupabase().from('orders').select().eq().eq() resolves to paid test orders.
  function stubSupabaseWith(rows: Array<{ id: string }>) {
    const eq2 = () => Promise.resolve({ data: rows, error: null });
    const eq1 = () => ({ eq: eq2 });
    return { from: () => ({ select: () => ({ eq: eq1 }) }) };
  }

  it("full-refunds every paid channel='test' order", async () => {
    const sb = stubSupabaseWith([{ id: "o1" }, { id: "o2" }]) as never;
    await refundTestOrders("shop-1", sb);
    expect(refundHoisted.executeRefundAction).toHaveBeenCalledTimes(2);
    expect(refundHoisted.executeRefundAction.mock.calls[0][1]).toMatchObject({ orderId: "o1" });
  });

  it("logs loudly and does NOT throw when a refund fails (cutover already committed)", async () => {
    const sb = stubSupabaseWith([{ id: "o1" }]) as never;
    refundHoisted.executeRefundAction.mockRejectedValueOnce(new Error("stripe down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(refundTestOrders("shop-1", sb)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/cutover/__tests__/test-transaction.server.test.ts`
Expected: FAIL — `refundTestOrders is not exported`.

- [ ] **Step 3: Write minimal implementation** (append to `test-transaction.server.ts`)

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { executeRefundAction } from "~/lib/actions/refund.server";

/**
 * Post-cutover cleanup: full-refund every paid channel='test' probe order for the shop.
 * Called by transitionOrgMode AFTER the -> live commit, so the probe was still `paid`
 * when the gate ran. Fail-loud but non-blocking (rule 12): the cutover already committed,
 * so a refund failure is logged + swallowed, never thrown back onto the live move. The
 * `capture` ledger row persists regardless, so captured_charge stays satisfied.
 */
export async function refundTestOrders(shopId: string, sb: SupabaseClient): Promise<void> {
  const { data, error } = await sb
    .from("orders")
    .select("id")
    .eq("shop_id", shopId)
    .eq("channel", "test");
  if (error) {
    console.error(`[cutover] failed to list test orders for shop ${shopId}`, error);
    return;
  }
  for (const row of (data ?? []) as Array<{ id: string }>) {
    try {
      await executeRefundAction(
        shopId,
        { orderId: row.id, idempotencyKey: `test-refund:${row.id}`, triggerReason: "go_live_test_cleanup" },
        sb,
      );
    } catch (err) {
      console.error(`[cutover] failed to refund test order ${row.id} for shop ${shopId}`, err);
    }
  }
}
```

> NOTE: the select filters `channel='test'` only (not `state='paid'`). `executeRefundAction` no-ops/refuses non-refundable states safely, and an already-refunded probe is idempotent via `idempotencyKey`. Keeping the filter to `channel` avoids a second query and is simpler to mock. If you prefer, add `.eq("state", "paid")` — update the test stub's `eq` chain depth to match.

- [ ] **Step 4: Hook into `transitionOrgMode`**

In `app/lib/cutover/org-mode.server.ts`, add the import near the top with the other cutover imports:

```ts
import { refundTestOrders } from "./test-transaction.server";
```

Then, inside `transitionOrgMode`, in the existing post-commit block (right after the `stampMigrationRunCutover` try/catch, before `return mapTransition(...)`), add:

```ts
  // The ->live move committed: unwind any go-live test-transaction probe. Best-effort —
  // the cutover already committed, so a cleanup failure is surfaced, never rolled back.
  if (to === "live") {
    await refundTestOrders(shopId, sb);
  }
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run app/lib/cutover/__tests__/test-transaction.server.test.ts && npm run typecheck`
Expected: PASS (5 tests), typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/lib/cutover/test-transaction.server.ts app/lib/cutover/org-mode.server.ts app/lib/cutover/__tests__/test-transaction.server.test.ts
git commit -m "feat(cutover): refund test-transaction probes after go-live commits"
```

---

### Task 3: Dashboard API route + client function

**Files:**
- Create: `app/routes/dashboard.api.cutover-test-transaction.tsx`
- Modify: `app/lib/dashboard/client.ts` (add `startTestTransaction`)
- Test: `app/routes/__tests__/dashboard.api.cutover-test-transaction.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/routes/__tests__/dashboard.api.cutover-test-transaction.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  requireDashboardSession: vi.fn(),
  requireSameOrigin: vi.fn(),
  startTestTransaction: vi.fn(),
}));
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: h.requireDashboardSession }));
vi.mock("~/lib/dashboard/http.server", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("~/lib/dashboard/http.server");
  return { ...actual, requireSameOrigin: h.requireSameOrigin };
});
vi.mock("~/lib/cutover/test-transaction.server", () => ({ startTestTransaction: h.startTestTransaction }));

import { action } from "../dashboard.api.cutover-test-transaction";

describe("POST /dashboard/api/cutover-test-transaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.requireDashboardSession.mockResolvedValue({ shopId: "shop-1" });
    h.startTestTransaction.mockResolvedValue({ url: "https://stripe/pay" });
  });

  it("returns the stripe checkout url", async () => {
    const req = new Request("http://x/dashboard/api/cutover-test-transaction", { method: "POST" });
    const res = await action({ request: req } as never);
    expect(await res.json()).toEqual({ url: "https://stripe/pay" });
  });

  it("returns 405 for non-POST", async () => {
    const req = new Request("http://x/dashboard/api/cutover-test-transaction", { method: "GET" });
    const res = await action({ request: req } as never);
    expect(res.status).toBe(405);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard.api.cutover-test-transaction.test.ts`
Expected: FAIL — cannot find `../dashboard.api.cutover-test-transaction`.

- [ ] **Step 3: Write the route**

```tsx
// app/routes/dashboard.api.cutover-test-transaction.tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { startTestTransaction } from "~/lib/cutover/test-transaction.server";

// POST: originate a go-live test transaction for the signed-in shop and return the Stripe
// Checkout url the merchant completes. Guards (dual_run, Stripe connected) live in
// startTestTransaction and surface as 400s carrying the message verbatim.
export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  try {
    const { url } = await startTestTransaction(session.shopId);
    return dashboardJson(async () => ({ url }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not start test transaction";
    return jsonError(400, "test_transaction_failed", message);
  }
}
```

> NOTE: confirm the `jsonError(status, code, detail?)` signature matches usage in `app/routes/dashboard.api.cutover.tsx` (it does there: `jsonError(409, "cutover_blocked", err.message)`). `dashboardJson` and `requireSameOrigin` come from the same `~/lib/dashboard/http.server` module.

- [ ] **Step 4: Add the client function** in `app/lib/dashboard/client.ts` (near `fetchPayoutLoginLink`, line ~703)

Use the existing `apiSend` helper (convention — matches `fetchPayoutLoginLink`). It sets the `Origin` header for the `requireSameOrigin` CSRF guard, redirects on 401, and throws `toApiError(res)` (which surfaces the server's `detail` message) on non-ok — so no hand-rolled fetch/error handling. `dashboardJson`→`jsonOk` returns the body directly (verified: `fetchPayoutLoginLink` gets `{ url }` with no `data` wrapper), so `apiSend<{ url: string }>` unwraps to `{ url }`.

```ts
export async function startTestTransaction(): Promise<{ url: string }> {
  return apiSend<{ url: string }>("POST", "/dashboard/api/cutover-test-transaction");
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run app/routes/__tests__/dashboard.api.cutover-test-transaction.test.ts && npm run typecheck`
Expected: PASS (2 tests), typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/routes/dashboard.api.cutover-test-transaction.tsx app/lib/dashboard/client.ts app/routes/__tests__/dashboard.api.cutover-test-transaction.test.ts
git commit -m "feat(cutover): API route + client for go-live test transaction"
```

---

### Task 4: Cutover screen button

**Files:**
- Modify: `app/components/dashboard/screens/Cutover.tsx`

- [ ] **Step 1: Add state + handler**

Inside `export default function Cutover({ app })`, near the other `useState` hooks (lines 94-99), add:

```tsx
  const [testBusy, setTestBusy] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const runTestTransaction = useCallback(async () => {
    setTestBusy(true);
    setTestError(null);
    try {
      const { url } = await client.startTestTransaction();
      window.open(url, "_blank", "noopener");
    } catch (e) {
      setTestError(e instanceof Error ? e.message : "Could not start test transaction");
    } finally {
      setTestBusy(false);
    }
  }, []);
```

- [ ] **Step 2: Render the button under the payment checks**

The checklist renders at `status.gates.checks.map((c) => ...)` (line ~278). Immediately AFTER that `.map(...)` block's closing element, when the shop is mid-cutover and a payment check is still failing, render the trigger. Add:

```tsx
{status.mode === "dual_run" &&
  status.gates.checks.some((c) => !c.pass && (c.name === "paid_order" || c.name === "captured_charge")) && (
    <div className="cd-cutover__test-tx">
      <button type="button" className="cd-btn" onClick={runTestTransaction} disabled={testBusy}>
        {testBusy ? "Starting…" : "Run a test transaction"}
      </button>
      <p className="cd-muted">
        Opens a secure Stripe checkout for a 50¢ charge to prove your payment setup. It’s
        automatically refunded when you go live.
      </p>
      {testError && <p className="cd-error">{testError}</p>}
    </div>
  )}
```

> NOTE: reuse whatever button/muted/error class names the surrounding JSX already uses (the file uses `cd-*` design-system classes — inspect the existing go-live and drift buttons at lines ~227 and ~315 and copy their `className`). Do not introduce new raw CSS; if a wrapper class is needed, follow the existing `cd-cutover__*` naming already present in this component.

- [ ] **Step 3: Verify the render path manually**

Run the app and open the Cutover screen for a `dual_run` shop with the payment checks red:
Run: `npm run dev` → navigate to `/dashboard` → Cutover tab.
Expected: the "Run a test transaction" button appears under the red payment checks; clicking opens a Stripe Checkout tab. After paying with a Stripe test card in a live-mode account (or completing the charge), reloading the screen shows both payment checks green.

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: exit 0 for both (build runs `scripts/verify-client-bundle.mjs` — the copy above contains no provenance markers).

- [ ] **Step 5: Commit**

```bash
git add app/components/dashboard/screens/Cutover.tsx
git commit -m "feat(cutover): Run a test transaction button on the go-live checklist"
```

---

### Task 5: Full verification pass (pre-commit gate)

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npx vitest run app/lib/cutover app/routes/__tests__/dashboard.api.cutover-test-transaction.test.ts`
Expected: all green.

- [ ] **Step 2: Typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all exit 0. Lint must be clean on the touched files (`--max-warnings=0` for new code).

- [ ] **Step 3: `/code-review` on the working tree**

Run the `/code-review` slash command; resolve every blocker; downgrade nits with a one-line justification.

- [ ] **Step 4: Patch sanity**

Run: `git diff --stat && git diff --check`
Expected: clean; no stray `console.log` (the two `console.error` calls are intentional, rule-12 fail-loud), no `.only`, no `TODO(me)`, no AI/provenance markers.

---

## Self-review notes (author)

- **Spec coverage:** components 1 (tag), 2 (`startTestTransaction`), 3 (webhook — unchanged, relied upon), 4 (Cutover UI), 5 (post-cutover cleanup) all map to Tasks 1-4. Component 6 (analytics exclusion) intentionally descoped — see "Descoped" section above; surfaced to the user as a deviation.
- **Type consistency:** `startTestTransaction` (Task 1) is the same name used by the route (Task 3) and client (Task 3); `refundTestOrders(shopId, sb)` (Task 2) matches its hook call in `org-mode.server.ts`. `TEST_CHARGE_CENTS` defined once (Task 1), asserted in test. `RefundActionInput` fields (`orderId`, `idempotencyKey`, `triggerReason`) match `refund.server.ts`.
- **Open runtime checks flagged inline** (not placeholders — explicit verify-then-branch): `orders.buyer_id` NOT NULL (Task 1 Step 4 note), `dashboardJson` envelope unwrap shape (Task 3 Step 4 note), exact `cd-*` class names (Task 4 Step 2 note).
```
