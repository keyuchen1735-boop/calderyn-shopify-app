import { describe, it, expect, vi, beforeEach } from "vitest";

const single = vi.fn();
const maybeSingle = vi.fn();
const updateEq = vi.fn().mockResolvedValue({ error: null });
const update = vi.fn(() => ({ eq: updateEq }));
const insert = vi.fn(() => ({ select: () => ({ single }) }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ insert, select: () => ({ eq: () => ({ maybeSingle }) }), update }) }),
}));
const sendEmail = vi.fn().mockResolvedValue({ sent: true, id: "e1" });
vi.mock("~/lib/email/send.server", () => ({ sendEmail }));

process.env.DASHBOARD_SESSION_PEPPER = "x".repeat(32);

beforeEach(() => { single.mockReset(); maybeSingle.mockReset(); insert.mockClear(); sendEmail.mockClear(); updateEq.mockClear(); });

describe("email verification tokens", () => {
  it("sendVerificationEmail mints a token and emails a /dashboard/verify link", async () => {
    process.env.RESEND_API_KEY = "re_x"; process.env.PILOT_FROM = "Calderyn <x@y.co>";
    single.mockResolvedValue({ data: { id: "tok1" }, error: null });
    const { sendVerificationEmail } = await import("../verify.server");
    await sendVerificationEmail("u1", "a@b.co", "https://app.x");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].text).toContain("https://app.x/dashboard/verify?t=");
  });

  it("consumeVerifyToken returns null for an expired token", async () => {
    maybeSingle.mockResolvedValue({ data: { id: "t", user_id: "u1", purpose: "verify", expires_at: new Date(Date.now() - 1000).toISOString(), used_at: null }, error: null });
    const { consumeVerifyToken } = await import("../verify.server");
    expect(await consumeVerifyToken("dash_live_x")).toBeNull();
  });

  it("consumeVerifyToken returns null for a used token and does not re-mark it", async () => {
    maybeSingle.mockResolvedValue({ data: { id: "t", user_id: "u1", purpose: "verify", expires_at: new Date(Date.now() + 10000).toISOString(), used_at: new Date().toISOString() }, error: null });
    const { consumeVerifyToken } = await import("../verify.server");
    expect(await consumeVerifyToken("dash_live_x")).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});
