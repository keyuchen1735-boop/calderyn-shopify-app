import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory Supabase stand-in: orders + buyer_dim, queried by .eq(...).maybeSingle() exactly like
// loadOrderAndBuyer does. Enforces shop-scoping (every read threads shop_id) so the test exercises
// real behavior, not a bare mock. Mirrors confirmation-email.server.test.ts's fixture.
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = { orders: [], buyer_dim: [], shop_origin: [], ship_rules: [] };

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
// Tenant storefront origin resolver: buyer links must be built from THIS, never the app/apex
// host, since storefront routes resolve their shop from the request Host subdomain.
const getShopStorefrontOrigin = vi.fn();

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));
vi.mock("~/lib/email/send.server", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
vi.mock("~/lib/storefront/shop.server", () => ({
  getShopStorefrontOrigin: (...a: unknown[]) => getShopStorefrontOrigin(...a),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import {
  sendShippingConfirmation,
  sendRefundNotice,
  sendCancellationNotice,
  sendInvoiceEmail,
  sendRecoveryEmailMessage,
} from "./notify-email.server";

const ORDER_ID = "11112222-3333-4444-5555-666677778888";
const TENANT_ORIGIN = "https://ember.calderyncompany.com";

beforeEach(() => {
  for (const k of Object.keys(store.db)) store.db[k].length = 0;
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  process.env.ORDER_CONFIRM_FROM = "Store <orders@example.com>";
  sendEmail.mockResolvedValue({ sent: true, id: "email-1" });
  getShopStorefrontOrigin.mockResolvedValue(TENANT_ORIGIN);
  store.db.orders.push({ id: ORDER_ID, shop_id: "shop-1", buyer_id: "buyer-1", currency: "usd" });
  store.db.buyer_dim.push({ id: "buyer-1", shop_id: "shop-1", email_normalized: "buyer@example.com" });
});

describe("sendShippingConfirmation", () => {
  it("emails the buyer with the order ref + tracking number when provided", async () => {
    const res = await sendShippingConfirmation("shop-1", ORDER_ID, { trackingNumber: "1Z999", carrier: "UPS" });
    expect(res.sent).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const args = sendEmail.mock.calls[0][0];
    expect(args.subject).toBe("Order #11112222 is on the way");
    expect(args.text).toContain("Good news! Your order #11112222 has shipped.");
    expect(args.text).toContain("Tracking: UPS 1Z999");
  });

  it("omits the tracking line when no tracking number is given", async () => {
    const res = await sendShippingConfirmation("shop-1", ORDER_ID, {});
    expect(res.sent).toBe(true);
    const args = sendEmail.mock.calls[0][0];
    expect(args.text).not.toContain("Tracking:");
  });

  it("does not send (and does not call sendEmail) when the buyer has no email on file", async () => {
    store.db.buyer_dim[0].email_normalized = "";
    const res = await sendShippingConfirmation("shop-1", ORDER_ID, {});
    expect(res.sent).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("swallows a sendEmail rejection into a structured failure (never throws)", async () => {
    sendEmail.mockRejectedValueOnce(new Error("network down"));
    await expect(sendShippingConfirmation("shop-1", ORDER_ID, {})).resolves.toEqual({
      sent: false,
      error: "network down",
    });
  });

  it("sends ready-for-pickup copy (no tracking) when the order's shipping_service is Store pickup", async () => {
    store.db.orders[0].shipping_service = "Store pickup";
    const res = await sendShippingConfirmation("shop-1", ORDER_ID, { trackingNumber: "1Z999", carrier: "UPS" });
    expect(res.sent).toBe(true);
    const args = sendEmail.mock.calls[0][0];
    expect(args.subject).toBe("Order #11112222 is ready for pickup");
    expect(args.text).toContain("Your order #11112222 is ready for pickup.");
    // Tracking is meaningless for a pickup order even if the caller passed one.
    expect(args.text).not.toContain("Tracking:");
    expect(args.html).not.toContain("Tracking:");
  });

  it("tells the pickup buyer WHERE to collect: origin address + merchant pickup note, escaped in html", async () => {
    store.db.orders[0].shipping_service = "Store pickup";
    store.db.shop_origin.push({ shop_id: "shop-1", street1: "1 Main St", city: "Portland", state: "OR", zip: "97201" });
    store.db.ship_rules.push({ shop_id: "shop-1", pickup_note: "Side entrance <b>only</b>" });
    const res = await sendShippingConfirmation("shop-1", ORDER_ID, {});
    expect(res.sent).toBe(true);
    const args = sendEmail.mock.calls[0][0];
    expect(args.text).toContain("Pick it up at: 1 Main St, Portland, OR, 97201");
    expect(args.text).toContain("Side entrance <b>only</b>");
    expect(args.html).toContain("Pick it up at: 1 Main St, Portland, OR, 97201");
    expect(args.html).toContain("Side entrance &lt;b&gt;only&lt;/b&gt;");
    expect(args.html).not.toContain("<b>only</b>");
  });

  it("escapes malicious tracking number and carrier in html (xss prevention)", async () => {
    const res = await sendShippingConfirmation("shop-1", ORDER_ID, {
      trackingNumber: "<img onerror=x>",
      carrier: '"><script>alert(1)</script>',
    });
    expect(res.sent).toBe(true);
    const args = sendEmail.mock.calls[0][0];
    // plaintext should preserve raw string
    expect(args.text).toContain('<img onerror=x>');
    expect(args.text).toContain('"><script>alert(1)</script>');
    // html should have escaped entities
    expect(args.html).toContain('&lt;img onerror=x&gt;');
    expect(args.html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(args.html).not.toContain('<img onerror=x>');
  });
});

describe("sendRefundNotice", () => {
  it("emails the buyer with the refunded amount", async () => {
    const res = await sendRefundNotice("shop-1", ORDER_ID, { amountCents: 1999 });
    expect(res.sent).toBe(true);
    const args = sendEmail.mock.calls[0][0];
    expect(args.text).toContain("We've issued a refund of $19.99 for order #11112222.");
    expect(args.text).toContain("5-10 business days");
  });

  it("does not send when the order is not found for the shop (shop-scoped)", async () => {
    const res = await sendRefundNotice("other-shop", ORDER_ID, { amountCents: 500 });
    expect(res.sent).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("swallows a sendEmail rejection into a structured failure (never throws)", async () => {
    sendEmail.mockRejectedValueOnce(new Error("timeout"));
    await expect(sendRefundNotice("shop-1", ORDER_ID, { amountCents: 500 })).resolves.toEqual({
      sent: false,
      error: "timeout",
    });
  });
});

describe("sendCancellationNotice", () => {
  it("mentions the refund when refunded is true", async () => {
    const res = await sendCancellationNotice("shop-1", ORDER_ID, { refunded: true });
    expect(res.sent).toBe(true);
    const args = sendEmail.mock.calls[0][0];
    expect(args.text).toContain("Your order #11112222 has been cancelled.");
    expect(args.text).toContain("A full refund has been issued to your original payment method.");
  });

  it("omits the refund sentence when refunded is false", async () => {
    const res = await sendCancellationNotice("shop-1", ORDER_ID, { refunded: false });
    expect(res.sent).toBe(true);
    const args = sendEmail.mock.calls[0][0];
    expect(args.text).not.toContain("A full refund has been issued");
  });

  it("fails visibly (no throw) when the mail transport is unconfigured", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.ORDER_CONFIRM_FROM;
    delete process.env.PILOT_FROM;
    delete process.env.DIGEST_FROM;
    const res = await sendCancellationNotice("shop-1", ORDER_ID, { refunded: false });
    expect(res.sent).toBe(false);
    expect(res.error).toMatch(/not configured/);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("sendInvoiceEmail", () => {
  const opts = {
    confirmationToken: "tok-abc123",
    lines: [{ title: "Cotton Tee - Small", quantity: 2 }],
    totalCents: 3998,
  };

  it("emails the buyer the invoice subject, line summary, total, and pay link built from the tenant storefront origin", async () => {
    const res = await sendInvoiceEmail("shop-1", ORDER_ID, opts);
    expect(res.sent).toBe(true);
    expect(getShopStorefrontOrigin).toHaveBeenCalledWith("shop-1");
    const args = sendEmail.mock.calls[0][0];
    expect(args.subject).toBe("Invoice for order #11112222");
    expect(args.text).toContain("Cotton Tee - Small x 2");
    expect(args.text).toContain("Total: $39.98");
    expect(args.text).toContain(`${TENANT_ORIGIN}/storefront/invoice/tok-abc123/pay`);
    expect(args.html).toContain("<li>Cotton Tee - Small x 2</li>");
    expect(args.html).toContain(`${TENANT_ORIGIN}/storefront/invoice/tok-abc123/pay`);
    // No em dashes anywhere in the copy.
    expect(args.text).not.toMatch(/[—–]/);
    expect(args.html).not.toMatch(/[—–]/);
  });

  it("does not send (and does not call sendEmail) when the shop has no resolvable storefront origin", async () => {
    getShopStorefrontOrigin.mockResolvedValueOnce("");
    const res = await sendInvoiceEmail("shop-1", ORDER_ID, opts);
    expect(res).toEqual({ sent: false, reason: "no_storefront_origin" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("includes the merchant note, escaped in html, verbatim in the plain-text body", async () => {
    const res = await sendInvoiceEmail("shop-1", ORDER_ID, {
      ...opts,
      note: '<script>alert("hi")</script>',
    });
    expect(res.sent).toBe(true);
    const args = sendEmail.mock.calls[0][0];
    expect(args.text).toContain('Note: <script>alert("hi")</script>');
    expect(args.html).toContain("&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt;");
    expect(args.html).not.toContain("<script>alert");
  });

  it("omits the note line entirely when no note is given", async () => {
    const res = await sendInvoiceEmail("shop-1", ORDER_ID, opts);
    expect(res.sent).toBe(true);
    const args = sendEmail.mock.calls[0][0];
    expect(args.text).not.toContain("Note:");
    expect(args.html).not.toContain("Note:");
  });

  it("does not send when the buyer has no email on file", async () => {
    store.db.buyer_dim[0].email_normalized = "";
    const res = await sendInvoiceEmail("shop-1", ORDER_ID, opts);
    expect(res.sent).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("swallows a sendEmail rejection into a structured failure (never throws)", async () => {
    sendEmail.mockRejectedValueOnce(new Error("network down"));
    await expect(sendInvoiceEmail("shop-1", ORDER_ID, opts)).resolves.toEqual({
      sent: false,
      error: "network down",
    });
  });

  it("fails visibly (no throw) when the mail transport is unconfigured", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.ORDER_CONFIRM_FROM;
    delete process.env.PILOT_FROM;
    delete process.env.DIGEST_FROM;
    const res = await sendInvoiceEmail("shop-1", ORDER_ID, opts);
    expect(res.sent).toBe(false);
    expect(res.error).toMatch(/not configured/);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("sendRecoveryEmailMessage", () => {
  const opts = {
    confirmationToken: "tok-recover123",
    lines: [{ title: "Cotton Tee - Small", quantity: 2 }],
    totalCents: 3998,
  };

  it("emails the buyer the recovery subject, line summary, total, and resume link built from the tenant storefront origin", async () => {
    const res = await sendRecoveryEmailMessage("shop-1", ORDER_ID, opts);
    expect(res.sent).toBe(true);
    expect(getShopStorefrontOrigin).toHaveBeenCalledWith("shop-1");
    const args = sendEmail.mock.calls[0][0];
    expect(args.subject).toBe("Your order is waiting");
    expect(args.text).toContain("Cotton Tee - Small x 2");
    expect(args.text).toContain("$39.98");
    expect(args.text).toContain(`${TENANT_ORIGIN}/storefront/recover/tok-recover123`);
    expect(args.html).toContain("<li>Cotton Tee - Small x 2</li>");
    expect(args.html).toContain(`${TENANT_ORIGIN}/storefront/recover/tok-recover123`);
    // Notes that prices/availability reflect current state.
    expect(args.text).toMatch(/prices and availability may have changed/i);
    // No em dashes anywhere in the copy.
    expect(args.text).not.toMatch(/[—–]/);
    expect(args.html).not.toMatch(/[—–]/);
  });

  it("does not send (and does not call sendEmail) when the shop has no resolvable storefront origin", async () => {
    getShopStorefrontOrigin.mockResolvedValueOnce("");
    const res = await sendRecoveryEmailMessage("shop-1", ORDER_ID, opts);
    expect(res).toEqual({ sent: false, reason: "no_storefront_origin" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does not send when the buyer has no email on file", async () => {
    store.db.buyer_dim[0].email_normalized = "";
    const res = await sendRecoveryEmailMessage("shop-1", ORDER_ID, opts);
    expect(res.sent).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("swallows a sendEmail rejection into a structured failure (never throws)", async () => {
    sendEmail.mockRejectedValueOnce(new Error("network down"));
    await expect(sendRecoveryEmailMessage("shop-1", ORDER_ID, opts)).resolves.toEqual({
      sent: false,
      error: "network down",
    });
  });

  it("fails visibly (no throw) when the mail transport is unconfigured", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.ORDER_CONFIRM_FROM;
    delete process.env.PILOT_FROM;
    delete process.env.DIGEST_FROM;
    const res = await sendRecoveryEmailMessage("shop-1", ORDER_ID, opts);
    expect(res.sent).toBe(false);
    expect(res.error).toMatch(/not configured/);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
