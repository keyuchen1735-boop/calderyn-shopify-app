import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildChain,
  setSupabaseResponses,
} from "../../__tests__/_supabase_chain_mock";

import { sendMerchantNewOrderNotice } from "../merchant-notify.server";

vi.mock("../../supabase.server", () => ({
  getSupabase: () => buildChain(),
  resolveShopId: vi.fn(),
}));
const sendEmail = vi.fn();
vi.mock("../../email/send.server", () => ({
  sendEmail: (...a: unknown[]) => sendEmail(...a),
}));
vi.mock("../checkout.server", () => ({
  formatOrderRef: (id: string) => `#${id.slice(0, 8).toUpperCase()}`,
}));

beforeEach(() => {
  sendEmail.mockReset().mockResolvedValue({ sent: true, id: "email-1" });
  process.env.RESEND_API_KEY = "re_test";
  process.env.ORDER_CONFIRM_FROM = "Calderyn <orders@calderyncompany.com>";
});

const ORDER = { id: "abcd1234-0000-0000-0000-000000000000", total_cents: 12345, currency: "usd", channel: "web" };
const OWNER_MEMBERSHIP = [
  { role: "member", created_at: "2026-01-02", user: { email: "staff@x.co" } },
  { role: "owner", created_at: "2026-01-01", user: { email: "owner@x.co" } },
];
const LINES = [
  { title_snapshot: "Trail Mug", quantity: 2, unit_price_cents: 1500 },
];

describe("sendMerchantNewOrderNotice", () => {
  it("emails the owner with the order ref, total, items, and next steps", async () => {
    setSupabaseResponses([
      { data: ORDER, error: null }, // orders read
      { data: OWNER_MEMBERSHIP, error: null }, // membership read
      { data: LINES, error: null }, // order_line read
    ]);
    const res = await sendMerchantNewOrderNotice("shop-1", ORDER.id);
    expect(res.sent).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = sendEmail.mock.calls[0][0] as { to: string; subject: string; text: string };
    expect(arg.to).toBe("owner@x.co"); // owner preferred over other members
    expect(arg.subject).toContain("New order");
    expect(arg.subject).toContain("$123.45");
    expect(arg.text).toContain("2 × Trail Mug");
    expect(arg.text).toContain(`/dashboard/orders/${ORDER.id}`);
    expect(arg.text).toContain("Fulfill");
  });

  it("never notifies for the go-live test probe (channel=test)", async () => {
    setSupabaseResponses([{ data: { ...ORDER, channel: "test" }, error: null }]);
    const res = await sendMerchantNewOrderNotice("shop-1", ORDER.id);
    expect(res.sent).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips quietly when the shop has no reachable merchant email", async () => {
    setSupabaseResponses([
      { data: ORDER, error: null }, // orders read
      { data: [], error: null }, // membership: none
      { data: { shop_domain: null }, error: null }, // shops fallback: no domain
    ]);
    const res = await sendMerchantNewOrderNotice("shop-1", ORDER.id);
    expect(res.sent).toBe(false);
    expect(res.error).toBe("no merchant email");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("returns a structured error (never throws) when transport is unconfigured", async () => {
    delete process.env.RESEND_API_KEY;
    setSupabaseResponses([
      { data: ORDER, error: null },
      { data: OWNER_MEMBERSHIP, error: null },
    ]);
    const res = await sendMerchantNewOrderNotice("shop-1", ORDER.id);
    expect(res.sent).toBe(false);
    expect(res.error).toBe("email transport not configured");
  });
});
