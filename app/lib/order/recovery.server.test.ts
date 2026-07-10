import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory Supabase stand-in covering every table recovery.server.ts touches: orders (read +
// the recovery_email_sent_at stamp UPDATE), order_state_transition (the reaper-cancel-reason
// lookup), buyer_dim (email gate), buyer_consent (marketing-consent gate), order_line (the email's
// line summary). Supports eq/is/gt/lt filters + order/limit, since autoSendRecoveryEmails's window
// scan needs all four (mirrors abandon-reaper.server.test.ts's Builder for eq/lt/order/limit).
type Row = Record<string, any>;

const store = vi.hoisted(() => {
  const db: Record<string, Row[]> = {
    orders: [],
    order_state_transition: [],
    buyer_dim: [],
    buyer_consent: [],
    order_line: [],
  };
  return { db };
});

class Builder {
  private op: "select" | "update" = "select";
  private vals: Row = {};
  private filters: Array<[string, unknown]> = [];
  private isFilters: Array<[string, unknown]> = [];
  private gtFilters: Array<[string, unknown]> = [];
  private ltFilters: Array<[string, unknown]> = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private wantSingle = false;
  private readonly table: string;
  constructor(table: string) {
    this.table = table;
  }
  select(_cols?: string) {
    return this;
  }
  update(vals: Row) {
    this.op = "update";
    this.vals = vals;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push([col, val]);
    return this;
  }
  is(col: string, val: unknown) {
    this.isFilters.push([col, val]);
    return this;
  }
  gt(col: string, val: unknown) {
    this.gtFilters.push([col, val]);
    return this;
  }
  lt(col: string, val: unknown) {
    this.ltFilters.push([col, val]);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col;
    this.orderAsc = opts?.ascending !== false;
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  maybeSingle() {
    this.wantSingle = true;
    return this;
  }
  then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
    return Promise.resolve(this.run()).then(resolve, reject);
  }
  private matches(r: Row) {
    return (
      this.filters.every(([c, v]) => r[c] === v) &&
      this.isFilters.every(([c, v]) => (v === null ? r[c] == null : r[c] === v)) &&
      this.gtFilters.every(([c, v]) => r[c] > (v as string)) &&
      this.ltFilters.every(([c, v]) => r[c] < (v as string))
    );
  }
  private run(): { data: unknown; error: unknown } {
    const t = store.db[this.table];
    if (this.op === "update") {
      const matched = t.filter((r) => this.matches(r));
      for (const r of matched) Object.assign(r, this.vals);
      return { data: matched, error: null };
    }
    let rows = t.filter((r) => this.matches(r));
    if (this.orderCol) {
      const col = this.orderCol;
      const dir = this.orderAsc ? 1 : -1;
      rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 * dir : a[col] > b[col] ? 1 * dir : 0));
    }
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    if (this.wantSingle) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
}

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: (t: string) => new Builder(t) }) }));

const emailer = vi.hoisted(() => ({ sendRecoveryEmailMessage: vi.fn() }));
vi.mock("./notify-email.server", () => ({ sendRecoveryEmailMessage: emailer.sendRecoveryEmailMessage }));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { sendRecoveryEmail, autoSendRecoveryEmails, REAPER_CANCEL_REASON } from "./recovery.server";

const NOW = new Date("2026-07-09T12:00:00.000Z");

function seedOrder(overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: "order-1",
    shop_id: "shop-1",
    buyer_id: "buyer-1",
    channel: "storefront",
    state: "checkout_pending",
    confirmation_token: "tok-1",
    total_cents: 3998,
    currency: "usd",
    created_at: NOW.toISOString(),
    recovery_email_sent_at: null,
    ...overrides,
  };
  store.db.orders.push(row);
  return row;
}
function seedBuyer(overrides: Partial<Row> = {}) {
  store.db.buyer_dim.push({ id: "buyer-1", shop_id: "shop-1", email_normalized: "buyer@example.com", ...overrides });
}
function seedConsent(overrides: Partial<Row> = {}) {
  store.db.buyer_consent.push({
    buyer_id: "buyer-1",
    shop_id: "shop-1",
    policy: "marketing",
    accepted: true,
    captured_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}
function seedLine(overrides: Partial<Row> = {}) {
  store.db.order_line.push({
    shop_id: "shop-1",
    order_id: "order-1",
    title_snapshot: "Cotton Tee",
    quantity: 1,
    ...overrides,
  });
}
function seedTransition(overrides: Partial<Row> = {}) {
  store.db.order_state_transition.push({
    shop_id: "shop-1",
    order_id: "order-1",
    to_state: "cancelled",
    reason: REAPER_CANCEL_REASON,
    occurred_at: NOW.toISOString(),
    ...overrides,
  });
}

beforeEach(() => {
  for (const k of Object.keys(store.db)) store.db[k].length = 0;
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  emailer.sendRecoveryEmailMessage.mockResolvedValue({ sent: true, id: "email-1" });
  seedBuyer();
  seedLine();
});

describe("sendRecoveryEmail", () => {
  it("sends the recovery email and stamps recovery_email_sent_at", async () => {
    seedOrder();
    seedConsent();

    const res = await sendRecoveryEmail("shop-1", "order-1");

    expect(res).toEqual({ sent: true });
    expect(emailer.sendRecoveryEmailMessage).toHaveBeenCalledWith("shop-1", "order-1", {
      confirmationToken: "tok-1",
      lines: [{ title: "Cotton Tee", quantity: 1 }],
      totalCents: 3998,
    });
    expect(store.db.orders[0].recovery_email_sent_at).toBe(NOW.toISOString());
  });

  it("returns not_found for an unknown order (shop-scoped) without touching anything", async () => {
    const res = await sendRecoveryEmail("shop-1", "no-such-order");
    expect(res).toEqual({ sent: false, reason: "not_found" });
    expect(emailer.sendRecoveryEmailMessage).not.toHaveBeenCalled();
  });

  it("no_consent: no marketing consent row at all -> skipped, nothing sent, no stamp", async () => {
    seedOrder();
    // No buyer_consent row seeded at all.

    const res = await sendRecoveryEmail("shop-1", "order-1");

    expect(res).toEqual({ sent: false, reason: "no_consent" });
    expect(emailer.sendRecoveryEmailMessage).not.toHaveBeenCalled();
    expect(store.db.orders[0].recovery_email_sent_at).toBeNull();
  });

  it("no_consent: marketing consent explicitly declined (accepted=false) -> skipped, no stamp", async () => {
    seedOrder();
    seedConsent({ accepted: false });

    const res = await sendRecoveryEmail("shop-1", "order-1");

    expect(res).toEqual({ sent: false, reason: "no_consent" });
    expect(emailer.sendRecoveryEmailMessage).not.toHaveBeenCalled();
    expect(store.db.orders[0].recovery_email_sent_at).toBeNull();
  });

  it("no_consent gates the MANUAL path too — a merchant can never override declined consent", async () => {
    seedOrder();
    seedConsent({ accepted: false });

    const res = await sendRecoveryEmail("shop-1", "order-1", { manual: true });

    expect(res).toEqual({ sent: false, reason: "no_consent" });
    expect(emailer.sendRecoveryEmailMessage).not.toHaveBeenCalled();
  });

  it("auto at-most-once: already-stamped order is skipped on the automatic path", async () => {
    seedOrder({ recovery_email_sent_at: "2026-01-01T00:00:00.000Z" });
    seedConsent();

    const res = await sendRecoveryEmail("shop-1", "order-1");

    expect(res).toEqual({ sent: false, reason: "already_sent" });
    expect(emailer.sendRecoveryEmailMessage).not.toHaveBeenCalled();
    // The original stamp is left untouched.
    expect(store.db.orders[0].recovery_email_sent_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("manual re-send is allowed even when already stamped, and re-stamps", async () => {
    seedOrder({ recovery_email_sent_at: "2026-01-01T00:00:00.000Z" });
    seedConsent();

    const res = await sendRecoveryEmail("shop-1", "order-1", { manual: true });

    expect(res).toEqual({ sent: true });
    expect(emailer.sendRecoveryEmailMessage).toHaveBeenCalledTimes(1);
    expect(store.db.orders[0].recovery_email_sent_at).toBe(NOW.toISOString());
  });

  it("not_recoverable: an invoice-channel order is never recoverable here", async () => {
    seedOrder({ channel: "invoice" });
    seedConsent();

    const res = await sendRecoveryEmail("shop-1", "order-1");

    expect(res).toEqual({ sent: false, reason: "not_recoverable" });
    expect(emailer.sendRecoveryEmailMessage).not.toHaveBeenCalled();
  });

  it("not_recoverable: a merchant-cancelled order (different reason string) is not recoverable", async () => {
    seedOrder({ state: "cancelled" });
    seedTransition({ reason: "merchant:cancel" });
    seedConsent();

    const res = await sendRecoveryEmail("shop-1", "order-1");

    expect(res).toEqual({ sent: false, reason: "not_recoverable" });
    expect(emailer.sendRecoveryEmailMessage).not.toHaveBeenCalled();
  });

  it("recoverable: a reaper-cancelled order (exact reason string match) still sends", async () => {
    seedOrder({ state: "cancelled" });
    seedTransition(); // reason defaults to REAPER_CANCEL_REASON
    seedConsent();

    const res = await sendRecoveryEmail("shop-1", "order-1");

    expect(res).toEqual({ sent: true });
    expect(emailer.sendRecoveryEmailMessage).toHaveBeenCalledTimes(1);
  });

  it("no_buyer_email: buyer has no email on file", async () => {
    store.db.buyer_dim[0].email_normalized = "";
    seedOrder();
    seedConsent();

    const res = await sendRecoveryEmail("shop-1", "order-1");

    expect(res).toEqual({ sent: false, reason: "no_buyer_email" });
    expect(emailer.sendRecoveryEmailMessage).not.toHaveBeenCalled();
  });

  it("a transport failure is not stamped — at-most-once must not spend its shot on a bounce", async () => {
    emailer.sendRecoveryEmailMessage.mockResolvedValueOnce({ sent: false, error: "smtp_down" });
    seedOrder();
    seedConsent();

    const res = await sendRecoveryEmail("shop-1", "order-1");

    expect(res).toEqual({ sent: false, reason: "smtp_down" });
    expect(store.db.orders[0].recovery_email_sent_at).toBeNull();
  });
});

describe("autoSendRecoveryEmails", () => {
  function hoursAgo(h: number): string {
    return new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();
  }

  it("only sweeps storefront checkout_pending orders aged 4h-24h with no stamp yet", async () => {
    seedOrder({ id: "o-fresh", created_at: hoursAgo(1) }); // too fresh
    seedOrder({ id: "o-window", created_at: hoursAgo(10) }); // in the window
    seedOrder({ id: "o-stale", created_at: hoursAgo(25) }); // already the reaper's territory
    seedOrder({ id: "o-invoice", created_at: hoursAgo(10), channel: "invoice" });
    seedOrder({ id: "o-paid", created_at: hoursAgo(10), state: "paid" });
    seedOrder({ id: "o-already-sent", created_at: hoursAgo(10), recovery_email_sent_at: hoursAgo(5) });
    seedConsent();

    const result = await autoSendRecoveryEmails();

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(emailer.sendRecoveryEmailMessage).toHaveBeenCalledTimes(1);
    expect(emailer.sendRecoveryEmailMessage).toHaveBeenCalledWith(
      "shop-1",
      "o-window",
      expect.objectContaining({ confirmationToken: "tok-1" }),
    );
    expect(store.db.orders.find((o) => o.id === "o-window")!.recovery_email_sent_at).toBe(NOW.toISOString());
    // Every non-candidate order is left completely untouched.
    for (const id of ["o-fresh", "o-stale", "o-invoice", "o-paid"]) {
      expect(store.db.orders.find((o) => o.id === id)!.recovery_email_sent_at).toBeNull();
    }
  });

  it("caps a single run at 50 candidates", async () => {
    for (let i = 0; i < 55; i++) {
      seedOrder({ id: `o-${i}`, created_at: hoursAgo(10) });
    }
    seedConsent();

    const result = await autoSendRecoveryEmails();

    expect(result.sent).toBe(50);
    expect(emailer.sendRecoveryEmailMessage).toHaveBeenCalledTimes(50);
  });

  it("isolates a per-order failure — one order's crash never blocks the rest of the sweep", async () => {
    seedOrder({ id: "o-good", created_at: hoursAgo(10) });
    seedOrder({ id: "o-bad", created_at: hoursAgo(10) });
    seedConsent();
    emailer.sendRecoveryEmailMessage.mockImplementation(async (_shopId: string, orderId: string) => {
      if (orderId === "o-bad") throw new Error("transient blip");
      return { sent: true, id: "email-1" };
    });

    const result = await autoSendRecoveryEmails();

    expect(result).toEqual({ sent: 1, skipped: 1 });
    expect(store.db.orders.find((o) => o.id === "o-good")!.recovery_email_sent_at).toBe(NOW.toISOString());
    expect(store.db.orders.find((o) => o.id === "o-bad")!.recovery_email_sent_at).toBeNull();
  });

  it("counts a gated candidate (e.g. no consent) as skipped, not sent", async () => {
    seedOrder({ id: "o-no-consent", created_at: hoursAgo(10) });
    // No consent row seeded.

    const result = await autoSendRecoveryEmails();

    expect(result).toEqual({ sent: 0, skipped: 1 });
  });
});
