import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory Supabase stand-in: orders + buyer_dim, queried by .eq(...).maybeSingle() exactly like
// sendOrderConfirmation does. Enforces shop-scoping (every read threads shop_id) so the test
// exercises real behavior, not a bare mock.
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = { orders: [], buyer_dim: [] };

  class Builder {
    private filters: Array<[string, unknown]> = [];
    private readonly table: string;
    constructor(table: string) {
      this.table = table;
    }
    select() {
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push([col, val]);
      return this;
    }
    maybeSingle() {
      const match = db[this.table].find((r) => this.filters.every(([c, v]) => r[c] === v)) ?? null;
      return Promise.resolve({ data: match, error: null });
    }
  }
  return { db, client: { from: (t: string) => new Builder(t) } };
});

const sendEmail = vi.fn();

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));
vi.mock("~/lib/email/send.server", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { sendOrderConfirmation } from "./confirmation-email.server";

beforeEach(() => {
  for (const k of Object.keys(store.db)) store.db[k].length = 0;
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  process.env.ORDER_CONFIRM_FROM = "Store <orders@example.com>";
  sendEmail.mockResolvedValue({ sent: true, id: "email-1" });
  store.db.orders.push({
    id: "11112222-3333-4444-5555-666677778888",
    shop_id: "shop-1",
    buyer_id: "buyer-1",
    total_cents: 3998,
    currency: "usd",
  });
  store.db.buyer_dim.push({ id: "buyer-1", shop_id: "shop-1", email_normalized: "buyer@example.com" });
});

describe("sendOrderConfirmation", () => {
  it("emails the buyer with the order reference + total", async () => {
    const res = await sendOrderConfirmation("shop-1", "11112222-3333-4444-5555-666677778888");
    expect(res.sent).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const args = sendEmail.mock.calls[0][0];
    expect(args.to).toBe("buyer@example.com");
    expect(args.subject).toContain("#11112222");
    expect(args.text).toContain("$39.98");
    expect(args.apiKey).toBe("re_test");
    expect(args.from).toBe("Store <orders@example.com>");
  });

  it("does not send (and reports) when the order is not found for the shop", async () => {
    const res = await sendOrderConfirmation("shop-1", "00000000-0000-0000-0000-000000000000");
    expect(res.sent).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("is shop-scoped: a foreign shop cannot resolve the order", async () => {
    const res = await sendOrderConfirmation("other-shop", "11112222-3333-4444-5555-666677778888");
    expect(res.sent).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("fails visibly (no throw) when the mail transport is unconfigured", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.ORDER_CONFIRM_FROM;
    delete process.env.PILOT_FROM;
    delete process.env.DIGEST_FROM;
    const res = await sendOrderConfirmation("shop-1", "11112222-3333-4444-5555-666677778888");
    expect(res.sent).toBe(false);
    expect(res.error).toMatch(/not configured/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("never throws when delivery fails — returns the structured failure", async () => {
    sendEmail.mockResolvedValueOnce({ sent: false, error: "Resend 500" });
    const res = await sendOrderConfirmation("shop-1", "11112222-3333-4444-5555-666677778888");
    expect(res.sent).toBe(false);
    expect(res.error).toBe("Resend 500");
  });
});
