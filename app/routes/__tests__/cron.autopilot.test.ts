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

// The shop-list query fails (DB outage). data is null, error is set.
function fakeSbError(message: string) {
  return {
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ data: null, error: { message } }),
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
    runAutopilotForShop.mockResolvedValue({ skipped: false, acted: 1, blocked: 0, failed: 0 });

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(runAutopilotForShop).toHaveBeenCalledTimes(2);
    expect(runAutopilotForShop).toHaveBeenCalledWith(SHOP_A, expect.anything());
    expect(runAutopilotForShop).toHaveBeenCalledWith(SHOP_B, expect.anything());
    expect(body.shops).toBe(2);
    expect(body.acted).toBe(2);
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

  it("sums acted, blocked and failed across shops", async () => {
    getSupabase.mockReturnValue(fakeSb([SHOP_A, SHOP_B]));
    runAutopilotForShop.mockResolvedValue({ skipped: false, acted: 1, blocked: 2, failed: 3 });

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(body.acted).toBe(2);
    expect(body.blocked).toBe(4);
    expect(body.failed).toBe(6);
  });

  it("aggregates considered and merges blockedReasons across shops", async () => {
    getSupabase.mockReturnValue(fakeSb([SHOP_A, SHOP_B]));
    runAutopilotForShop
      .mockResolvedValueOnce({
        skipped: false,
        acted: 0,
        blocked: 2,
        failed: 0,
        considered: 2,
        blockedReasons: { "campaign spend below minimum": 2 },
        decisions: [],
      })
      .mockResolvedValueOnce({
        skipped: false,
        acted: 1,
        blocked: 1,
        failed: 0,
        considered: 3,
        blockedReasons: { "campaign spend below minimum": 1, "daily action cap reached": 1 },
        decisions: [],
      });

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(body.considered).toBe(5);
    expect(body.blockedReasons).toEqual({
      "campaign spend below minimum": 3,
      "daily action cap reached": 1,
    });
  });

  it("emits one structured summary log line", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    getSupabase.mockReturnValue(fakeSb([SHOP_A]));
    runAutopilotForShop.mockResolvedValue({
      skipped: false,
      acted: 0,
      blocked: 1,
      failed: 0,
      considered: 1,
      blockedReasons: { "campaign spend below minimum": 1 },
      decisions: [],
    });

    await loader({ request: req("Bearer s3cret") } as never);

    const summaryCall = infoSpy.mock.calls.find((c) => String(c[0]).includes("[cron.autopilot] summary"));
    expect(summaryCall).toBeDefined();
    expect(summaryCall?.[1]).toMatchObject({
      considered: 1,
      blockedReasons: { "campaign spend below minimum": 1 },
    });
    infoSpy.mockRestore();
  });

  it("surfaces a shop-list query error instead of silently reporting zero shops", async () => {
    getSupabase.mockReturnValue(fakeSbError("connection terminated"));

    const res = await loader({ request: req("Bearer s3cret") } as never);

    expect(res.status).toBe(500);
    expect(runAutopilotForShop).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toContain("connection terminated");
  });
});
