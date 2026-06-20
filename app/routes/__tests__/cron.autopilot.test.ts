import { describe, it, expect, vi, beforeEach } from "vitest";
import { loader } from "../cron.autopilot";

// vi.mock is hoisted above imports by Vitest, so the mocks below still apply to
// the loader import above.
const { runAutopilotForShop, getSupabase } = vi.hoisted(() => ({
  runAutopilotForShop: vi.fn(),
  getSupabase: vi.fn(),
}));

vi.mock("~/lib/actions/autopilot.server", () => ({ runAutopilotForShop }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase }));

const SHOP_A = "aaaaaaaa-0000-0000-0000-000000000001";
const SHOP_B = "bbbbbbbb-0000-0000-0000-000000000002";

function fakeSb(shopIds: string[]) {
  return {
    from: () => ({
      select: () => ({
        eq: () =>
          Promise.resolve({
            data: shopIds.map((id) => ({ shop_id: id })),
            error: null,
          }),
      }),
    }),
  };
}

function req(auth?: string): Request {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request("http://x/cron/autopilot", { headers });
}

describe("cron.autopilot loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "s3cret";
  });

  it("rejects an unauthorized request", async () => {
    getSupabase.mockReturnValue(fakeSb([]));
    const res = await loader({ request: req("Bearer wrong") } as never);
    expect(res.status).toBe(401);
  });

  it("calls runAutopilotForShop once per enabled shop", async () => {
    getSupabase.mockReturnValue(fakeSb([SHOP_A, SHOP_B]));
    runAutopilotForShop.mockResolvedValue({ skipped: false, acted: 1, blocked: 0, failed: 1 });

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(runAutopilotForShop).toHaveBeenCalledTimes(2);
    expect(runAutopilotForShop).toHaveBeenCalledWith(SHOP_A, expect.anything());
    expect(runAutopilotForShop).toHaveBeenCalledWith(SHOP_B, expect.anything());
    expect(body.shops).toBe(2);
    expect(body.acted).toBe(2);
    // Per-candidate failures from each shop are summed into the cron response.
    expect(body.failed).toBe(2);
  });

  it("isolates one shop's throw into errors without aborting the other", async () => {
    getSupabase.mockReturnValue(fakeSb([SHOP_A, SHOP_B]));
    runAutopilotForShop
      .mockRejectedValueOnce(new Error("shop A exploded"))
      .mockResolvedValueOnce({ skipped: false, acted: 1, blocked: 0, failed: 0 });

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toContain(SHOP_A);
    expect(body.errors[0]).toContain("shop A exploded");
    // Shop B still ran and counted
    expect(body.shops).toBe(1);
    expect(body.acted).toBe(1);
  });
});
