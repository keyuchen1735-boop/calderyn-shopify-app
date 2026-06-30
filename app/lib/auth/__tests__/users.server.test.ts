import { describe, it, expect, vi, beforeEach } from "vitest";

// users.server computes a module-load DUMMY_HASH via scrypt; the pepper must be
// set before the dynamic import("../users.server") inside the test bodies.
process.env.PASSWORD_PEPPER = "x".repeat(32);

const maybeSingle = vi.fn();
const single = vi.fn();
const insert = vi.fn(() => ({ select: () => ({ single }) }));
const deleteEq = vi.fn().mockResolvedValue({ error: null });
const deleteFn = vi.fn(() => ({ eq: deleteEq }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle }) }),
      insert,
      delete: deleteFn,
    }),
  }),
}));

beforeEach(() => {
  maybeSingle.mockReset();
  single.mockReset();
  deleteEq.mockReset().mockResolvedValue({ error: null });
  deleteFn.mockClear();
});

describe("users data layer", () => {
  it("normalizes and validates email", async () => {
    const { normalizeEmail, isValidEmail } = await import("../users.server");
    expect(normalizeEmail("  A@B.CO ")).toBe("a@b.co");
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("nope")).toBe(false);
  });

  it("verifyUserCredentials returns null for an unknown email", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const { verifyUserCredentials } = await import("../users.server");
    expect(await verifyUserCredentials("ghost@x.co", "pw")).toBeNull();
  });

  it("verifyUserCredentials returns the id for a correct password", async () => {
    const { hashPassword } = await import("../password.server");
    maybeSingle.mockResolvedValue({
      data: { id: "u1", password_hash: hashPassword("hunter2") },
      error: null,
    });
    const { verifyUserCredentials } = await import("../users.server");
    expect(await verifyUserCredentials("a@b.co", "hunter2")).toEqual({ id: "u1" });
    expect(await verifyUserCredentials("a@b.co", "wrong")).toBeNull();
  });

  it("deleteUser calls delete().eq(id) and resolves without error", async () => {
    const { deleteUser } = await import("../users.server");
    await expect(deleteUser("u99")).resolves.toBeUndefined();
    expect(deleteFn).toHaveBeenCalled();
    expect(deleteEq).toHaveBeenCalledWith("id", "u99");
  });
});
