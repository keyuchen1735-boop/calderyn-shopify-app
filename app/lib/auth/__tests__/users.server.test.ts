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

// Count verifyPassword calls (proving scrypt CPU is spent) while still delegating
// to the real implementation so correctness assertions stay meaningful.
const { verifyPasswordSpy, ref } = vi.hoisted(() => {
  const ref: { real: ((pw: string, hash: string) => boolean) | null } = { real: null };
  return { verifyPasswordSpy: vi.fn((pw: string, hash: string) => (ref.real ? ref.real(pw, hash) : false)), ref };
});
vi.mock("../password.server", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../password.server")>();
  ref.real = orig.verifyPassword;
  return { ...orig, verifyPassword: (pw: string, hash: string) => verifyPasswordSpy(pw, hash) };
});

beforeEach(() => {
  maybeSingle.mockReset();
  single.mockReset();
  deleteEq.mockReset().mockResolvedValue({ error: null });
  deleteFn.mockClear();
  verifyPasswordSpy.mockClear();
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

  it("verifyUserCredentials burns scrypt for a passwordless (Google-only) account", async () => {
    // password_hash NULL => Google-only. Must spend the same CPU as an unknown
    // email (verifyPassword against the dummy hash), not skip it, so timing can't
    // enumerate which addresses are Google accounts.
    maybeSingle.mockResolvedValue({ data: { id: "u-g", password_hash: null }, error: null });
    const { verifyUserCredentials } = await import("../users.server");
    expect(await verifyUserCredentials("g@x.co", "whatever")).toBeNull();
    expect(verifyPasswordSpy).toHaveBeenCalledTimes(1);
  });

  it("deleteUser calls delete().eq(id) and resolves without error", async () => {
    const { deleteUser } = await import("../users.server");
    await expect(deleteUser("u99")).resolves.toBeUndefined();
    expect(deleteFn).toHaveBeenCalled();
    expect(deleteEq).toHaveBeenCalledWith("id", "u99");
  });
});
