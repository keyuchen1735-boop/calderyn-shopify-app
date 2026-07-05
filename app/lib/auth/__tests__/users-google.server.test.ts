import { describe, it, expect, vi, beforeEach } from "vitest";

const maybeSingle = vi.fn();
const single = vi.fn();
const insert = vi.fn(() => ({ select: () => ({ single }) }));
const updateEq = vi.fn().mockResolvedValue({ error: null });
const update = vi.fn(() => ({ eq: updateEq }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }), insert, update }) }),
}));
process.env.PASSWORD_PEPPER = "x".repeat(32);

beforeEach(() => { maybeSingle.mockReset(); single.mockReset(); insert.mockClear(); update.mockClear(); updateEq.mockClear(); });

describe("google identity", () => {
  it("createGoogleUser inserts google_sub + email_verified true and returns id", async () => {
    single.mockResolvedValue({ data: { id: "u9" }, error: null });
    const { createGoogleUser } = await import("../users.server");
    expect(await createGoogleUser("A@B.co", "g9")).toEqual({ id: "u9" });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ email: "a@b.co", google_sub: "g9", email_verified: true }));
  });
  it("findUserByGoogleSub returns null when absent", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const { findUserByGoogleSub } = await import("../users.server");
    expect(await findUserByGoogleSub("nope")).toBeNull();
  });
  // onboardedAt is load-bearing: the Google callback uses it to decide whether a
  // returning user still owes onboarding, so the finder must surface it.
  it("findUserByGoogleSub returns id, shopId and onboardedAt", async () => {
    maybeSingle.mockResolvedValue({ data: { id: "u1", membership: { shop_id: "s1" }, onboarded_at: "2026-01-01T00:00:00Z" }, error: null });
    const { findUserByGoogleSub } = await import("../users.server");
    expect(await findUserByGoogleSub("gsub")).toEqual({ id: "u1", shopId: "s1", onboardedAt: "2026-01-01T00:00:00Z" });
  });
  it("findUserByGoogleSub yields onboardedAt null for a user who never onboarded", async () => {
    maybeSingle.mockResolvedValue({ data: { id: "u1", membership: null, onboarded_at: null }, error: null });
    const { findUserByGoogleSub } = await import("../users.server");
    expect(await findUserByGoogleSub("gsub")).toEqual({ id: "u1", shopId: null, onboardedAt: null });
  });
  it("findUserByEmail returns id, passwordHash and onboardedAt", async () => {
    maybeSingle.mockResolvedValue({ data: { id: "u2", password_hash: "h", onboarded_at: null }, error: null });
    const { findUserByEmail } = await import("../users.server");
    expect(await findUserByEmail("a@b.co")).toEqual({ id: "u2", passwordHash: "h", onboardedAt: null });
  });
});
