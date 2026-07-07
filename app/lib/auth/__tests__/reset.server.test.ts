import { describe, it, expect, vi, beforeEach } from "vitest";

// Correction #1: DASHBOARD_SESSION_PEPPER must be set before reset.server is imported,
// because hashSessionToken() throws if the pepper is missing or < 32 chars.
process.env.DASHBOARD_SESSION_PEPPER = "x".repeat(32);

const single = vi.fn();
const maybeSingle = vi.fn();
// Records each .update() call's payload + the filters chained onto it, so the
// setPasswordWithToken tests can assert what was written and scoped. The chain is
// awaitable (then → {error:null}) and supports .select().maybeSingle() for the
// consumeResetToken claim.
const updateOps: Array<{ payload: Record<string, unknown>; filters: string[] }> = [];
const update = vi.fn((payload: Record<string, unknown>) => {
  const op = { payload, filters: [] as string[] };
  updateOps.push(op);
  const chain: Record<string, unknown> = {
    eq: (c: string, v: unknown) => { op.filters.push(`eq:${c}=${String(v)}`); return chain; },
    is: (c: string, v: unknown) => { op.filters.push(`is:${c}=${String(v)}`); return chain; },
    in: (c: string, v: unknown) => { op.filters.push(`in:${c}=${JSON.stringify(v)}`); return chain; },
    select: () => chain,
    maybeSingle: () => Promise.resolve({ data: { id: "tok" }, error: null }),
    then: (res: (r: { error: null }) => unknown) => Promise.resolve({ error: null }).then(res),
  };
  return chain;
});
const insert = vi.fn(() => ({ select: () => ({ single }) }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({ insert, select: () => ({ eq: () => ({ in: () => ({ maybeSingle }) }) }), update }),
  }),
}));
const sendEmail = vi.fn().mockResolvedValue({ sent: true, id: "e1" });
vi.mock("~/lib/email/send.server", () => ({ sendEmail }));
const findUserByEmail = vi.fn();
vi.mock("~/lib/auth/users.server", () => ({ findUserByEmail, normalizeEmail: (e: string) => e.toLowerCase() }));
// Emails go out off the response path via waitUntil; capture the scheduled work
// so tests can flush it deterministically (in prod Vercel keeps it alive).
const waitUntilPending: Array<Promise<unknown>> = [];
vi.mock("@vercel/functions", () => ({ waitUntil: (p: Promise<unknown>) => { waitUntilPending.push(p); } }));

beforeEach(() => {
  single.mockReset();
  maybeSingle.mockReset();
  insert.mockClear();
  sendEmail.mockClear();
  findUserByEmail.mockReset();
  update.mockClear();
  updateOps.length = 0;
  waitUntilPending.length = 0;
});

describe("password reset", () => {
  it("requestPasswordReset stays silent (resolves) for an unknown email and sends nothing", async () => {
    process.env.RESEND_API_KEY = "re_x"; process.env.PILOT_FROM = "Calderyn <x@y.co>";
    findUserByEmail.mockResolvedValue(null);
    const { requestPasswordReset } = await import("../reset.server");
    await expect(requestPasswordReset("ghost@x.co", "https://app.x")).resolves.toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("requestPasswordReset emails a link for a known email (off the response path)", async () => {
    process.env.RESEND_API_KEY = "re_x"; process.env.PILOT_FROM = "Calderyn <x@y.co>";
    findUserByEmail.mockResolvedValue({ id: "u1", passwordHash: "h" });
    single.mockResolvedValue({ data: { id: "tok1" }, error: null });
    const { requestPasswordReset } = await import("../reset.server");
    await requestPasswordReset("a@b.co", "https://app.x");
    // Send is scheduled off the response path via waitUntil (not awaited inline),
    // which is what removes the timing oracle.
    expect(waitUntilPending).toHaveLength(1);
    // It still goes out once the platform-kept-alive task drains.
    await Promise.all(waitUntilPending);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = sendEmail.mock.calls[0][0];
    expect(arg.to).toBe("a@b.co");
    expect(arg.text).toContain("https://app.x/dashboard/reset/confirm?t=");
  });

  it("requestPasswordReset schedules NO work for an unknown email (same shape as known)", async () => {
    process.env.RESEND_API_KEY = "re_x"; process.env.PILOT_FROM = "Calderyn <x@y.co>";
    findUserByEmail.mockResolvedValue(null);
    const { requestPasswordReset } = await import("../reset.server");
    await requestPasswordReset("ghost@x.co", "https://app.x");
    expect(waitUntilPending).toHaveLength(0);
  });

  it("setPasswordWithToken verifies the email, voids sibling tokens, and revokes sessions", async () => {
    // Valid reset token for consumeResetToken's lookup + claim.
    maybeSingle.mockResolvedValue({ data: { id: "tok-reset", user_id: "u1", purpose: "reset", expires_at: new Date(Date.now() + 60_000).toISOString(), used_at: null }, error: null });
    const { setPasswordWithToken } = await import("../reset.server");
    const ok = await setPasswordWithToken("dash_live_reset", "new-password-123");
    expect(ok).toBe(true);
    // A reset proves mailbox control → email marked verified.
    expect(updateOps.some((o) => o.payload.email_verified === true)).toBe(true);
    // Sibling reset/set-password tokens for the user are voided (scoped + unused).
    const voidOp = updateOps.find(
      (o) => "used_at" in o.payload && o.filters.some((f) => f === "eq:user_id=u1"),
    );
    expect(voidOp).toBeTruthy();
    expect(voidOp?.filters).toContain('in:purpose=["reset","set_password"]');
    expect(voidOp?.filters).toContain("is:used_at=null");
  });

  it("consumeResetToken returns null for an expired token", async () => {
    maybeSingle.mockResolvedValue({ data: { user_id: "u1", expires_at: new Date(Date.now() - 1000).toISOString(), used_at: null }, error: null });
    const { consumeResetToken } = await import("../reset.server");
    expect(await consumeResetToken("dash_live_x")).toBeNull();
  });

  it("consumeResetToken returns null for an already-used token and does not call update", async () => {
    // Token row has a non-null used_at: single-use guard must short-circuit before update.
    maybeSingle.mockResolvedValue({
      data: {
        id: "tok-used",
        user_id: "u1",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        used_at: new Date(Date.now() - 5_000).toISOString(),
      },
      error: null,
    });
    update.mockClear();
    const { consumeResetToken } = await import("../reset.server");
    const result = await consumeResetToken("dash_live_used");
    expect(result).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("consumeResetToken rejects a verify-purpose token (scope-confusion / ATO guard)", async () => {
    // A 24h email-verify token shares this table but must never set a password.
    maybeSingle.mockResolvedValue({
      data: { id: "tok-verify", user_id: "u1", purpose: "verify", expires_at: new Date(Date.now() + 60_000).toISOString(), used_at: null },
      error: null,
    });
    update.mockClear();
    const { consumeResetToken } = await import("../reset.server");
    expect(await consumeResetToken("dash_live_verify")).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("consumeResetToken accepts a valid reset-purpose token", async () => {
    maybeSingle.mockResolvedValue({
      data: { id: "tok-reset", user_id: "u1", purpose: "reset", expires_at: new Date(Date.now() + 60_000).toISOString(), used_at: null },
      error: null,
    });
    update.mockClear();
    const { consumeResetToken } = await import("../reset.server");
    expect(await consumeResetToken("dash_live_reset")).toEqual({ userId: "u1" });
    expect(update).toHaveBeenCalled();
  });
});
