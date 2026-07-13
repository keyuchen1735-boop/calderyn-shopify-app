import { describe, it, expect, beforeEach } from "vitest";
import { isValidNoteBody, resolveAuthorEmail } from "./notes.server";

describe("isValidNoteBody", () => {
  it("accepts 1-2000 chars, rejects empty/over-length/non-string", () => {
    expect(isValidNoteBody("hi")).toBe(true);
    expect(isValidNoteBody("a".repeat(2000))).toBe(true);
    expect(isValidNoteBody("")).toBe(false);
    expect(isValidNoteBody("a".repeat(2001))).toBe(false);
    expect(isValidNoteBody(42)).toBe(false);
    expect(isValidNoteBody(undefined)).toBe(false);
  });
});

describe("resolveAuthorEmail", () => {
  const store = { db: [] as Array<{ id: string; email: string | null }> };

  function fakeSupabase() {
    return {
      from: (_table: string) => ({
        select: (_c: string) => ({
          eq: (_col: string, id: string) => ({
            maybeSingle: async () => {
              const row = store.db.find((r) => r.id === id);
              return { data: row ? { email: row.email } : null, error: null };
            },
          }),
        }),
      }),
    } as any;
  }

  beforeEach(() => {
    store.db = [];
  });

  it("falls back to 'merchant' when userId is null (Shopify-based session)", async () => {
    expect(await resolveAuthorEmail(fakeSupabase(), null)).toBe("merchant");
  });

  it("falls back to 'merchant' when the user row has no email or is missing", async () => {
    store.db.push({ id: "u1", email: null });
    expect(await resolveAuthorEmail(fakeSupabase(), "u1")).toBe("merchant");
    expect(await resolveAuthorEmail(fakeSupabase(), "ghost")).toBe("merchant");
  });

  it("resolves the real email for a first-party user", async () => {
    store.db.push({ id: "u1", email: "jane@example.com" });
    expect(await resolveAuthorEmail(fakeSupabase(), "u1")).toBe("jane@example.com");
  });

  it("throws on a Supabase error rather than swallowing it", async () => {
    const sb = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: new Error("db down") }) }) }) }) } as any;
    await expect(resolveAuthorEmail(sb, "u1")).rejects.toThrow("db down");
  });
});
