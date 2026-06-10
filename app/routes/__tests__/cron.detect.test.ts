import { describe, it, expect, vi, beforeEach } from "vitest";
import { loader } from "../cron.detect";

const { getSupabase } = vi.hoisted(() => ({
  getSupabase: vi.fn(),
}));

vi.mock("~/lib/supabase.server", () => ({ getSupabase }));

const SHOP_A = "aaaaaaaa-0000-0000-0000-000000000001";

function fakeSb(shopIds: string[]) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: () =>
              Promise.resolve({
                data: shopIds.map((id) => ({ shop_id: id })),
                error: null,
              }),
          }),
        }),
      }),
    }),
  };
}

function req(auth?: string): Request {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request("https://deployment-url.vercel.app/cron/detect", { headers });
}

describe("cron.detect loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    process.env.CRON_SECRET = "s3cret";
  });

  it("rejects an unauthorized request", async () => {
    getSupabase.mockReturnValue(fakeSb([]));
    const res = await loader({ request: req("Bearer wrong") } as never);
    expect(res.status).toBe(401);
  });

  it("calls the engine through the public app origin, not the request origin", async () => {
    // Vercel cron invokes this route on the deployment URL, which deployment
    // protection walls off from the self-fetch — the engine call must go
    // through the public app origin instead.
    vi.stubEnv("SHOPIFY_APP_URL", "https://app.example.com");
    getSupabase.mockReturnValue(fakeSb([SHOP_A]));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ shop_id: SHOP_A, alert_ids: ["a1"] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.example.com/api/engine/run",
      expect.anything(),
    );
    expect(body.detected).toEqual([SHOP_A]);
    expect(body.alertCount).toBe(1);
  });

  it("falls back to the request origin when SHOPIFY_APP_URL is unset", async () => {
    vi.stubEnv("SHOPIFY_APP_URL", "");
    getSupabase.mockReturnValue(fakeSb([SHOP_A]));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ shop_id: SHOP_A, alert_ids: [] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await loader({ request: req("Bearer s3cret") } as never);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://deployment-url.vercel.app/api/engine/run",
      expect.anything(),
    );
  });

  it("records an engine HTTP failure without aborting the run", async () => {
    vi.stubEnv("SHOPIFY_APP_URL", "https://app.example.com");
    getSupabase.mockReturnValue(fakeSb([SHOP_A]));
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("Authentication Required", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(body.errors).toEqual([SHOP_A]);
    expect(body.detected).toEqual([]);
  });
});
