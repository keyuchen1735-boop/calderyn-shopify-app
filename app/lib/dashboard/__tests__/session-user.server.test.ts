import { describe, it, expect, vi, beforeEach } from "vitest";

const insert = vi.fn(() => ({ select: () => ({ single: () => Promise.resolve({ data: { id: "sess1" }, error: null }) }) }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ insert }) }),
  resolveShopId: vi.fn(),
}));
vi.mock("~/lib/actions/snooze.server", () => ({ resurfaceAllSnoozes: vi.fn().mockResolvedValue(undefined) }));

beforeEach(() => { insert.mockClear(); });

describe("createSessionForUser", () => {
  it("inserts a session row carrying user_id and shop_id", async () => {
    process.env.DASHBOARD_SESSION_PEPPER = "x".repeat(32);
    const { createSessionForUser } = await import("../session.server");
    const { raw } = await createSessionForUser("u1", "shop1");
    expect(raw.startsWith("dash_live_")).toBe(true);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "u1", shop_id: "shop1" }),
    );
  });
});
