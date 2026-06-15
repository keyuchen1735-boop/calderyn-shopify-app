import { describe, it, expect, vi } from "vitest";

const insert = vi.fn().mockResolvedValue({ error: null });
const limit = vi.fn().mockResolvedValue({ data: [{ id: "1" }], error: null });
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      insert,
      select: () => ({ eq: () => ({ eq: () => ({ limit }) }) }),
    }),
  }),
}));

describe("invites store", () => {
  it("logInvite inserts a normalized row", async () => {
    const { logInvite } = await import("../invites.server");
    const r = await logInvite({ email: "A@B.co", firstName: "A", storeName: "B", status: "sent", resendId: "x" });
    expect(r.ok).toBe(true);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ email: "a@b.co", status: "sent", resend_id: "x" }));
  });
  it("hasSuccessfulInvite reports true when a sent row exists", async () => {
    const { hasSuccessfulInvite } = await import("../invites.server");
    expect(await hasSuccessfulInvite("a@b.co")).toEqual({ invited: true });
  });
});
