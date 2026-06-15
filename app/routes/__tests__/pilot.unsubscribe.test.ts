import { describe, it, expect, beforeEach, vi } from "vitest";

const upsert = vi.fn().mockResolvedValue({ error: null });
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: () => ({ upsert }) }) }));
beforeEach(() => { process.env.PILOT_UNSUB_SECRET = "t"; upsert.mockClear(); });

describe("/pilot/unsubscribe", () => {
  it("400s an invalid token on GET", async () => {
    const { loader } = await import("../pilot.unsubscribe");
    const res = await loader({ request: new Request("https://app.test/pilot/unsubscribe?token=bad"), params: {}, context: {} });
    expect(res.status).toBe(400);
  });
  it("records the opt-out on POST with a valid token", async () => {
    const { signUnsubToken } = await import("~/lib/pilot-invite/unsubscribe.server");
    const { action } = await import("../pilot.unsubscribe");
    const token = await signUnsubToken("a@b.co");
    const res = await action({ request: new Request(`https://app.test/pilot/unsubscribe?token=${token}`, { method: "POST" }), params: {}, context: {} });
    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ email: "a@b.co" }), expect.anything());
  });
});
