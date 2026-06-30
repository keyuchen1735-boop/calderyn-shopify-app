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
});
