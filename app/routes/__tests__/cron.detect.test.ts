import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loader } from "../cron.detect";

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: () =>
              Promise.resolve({ data: [{ shop_id: "24c18b19-3a4f-4651-9446-969726c30223" }] }),
          }),
        }),
      }),
    }),
  }),
}));

function req(url: string, auth?: string): Request {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request(url, { headers });
}

describe("cron.detect loader", () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ shop_id: "24c18b19-3a4f-4651-9446-969726c30223", alert_ids: ["a"] }),
  }));

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "s3cret";
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SHOPIFY_APP_URL;
  });

  it("rejects an unauthorized request", async () => {
    const res = await loader({ request: req("http://x/cron/detect", "Bearer wrong") } as never);
    expect(res.status).toBe(401);
  });

  it("calls the engine on SHOPIFY_APP_URL, not the request origin", async () => {
    // Vercel invokes crons on the SSO-protected *.vercel.app deployment URL;
    // a self-fetch derived from request.url gets a 401 at the edge before the
    // engine function is ever reached (prod incident 2026-06-10). The public
    // app URL must win when configured.
    process.env.SHOPIFY_APP_URL = "https://app.example.com";
    const res = await loader({
      request: req("https://deploy-abc123.vercel.app/cron/detect", "Bearer s3cret"),
    } as never);
    const body = await res.json();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.example.com/api/engine/run",
      expect.anything(),
    );
    expect(body.detected).toEqual(["24c18b19-3a4f-4651-9446-969726c30223"]);
    expect(body.errors).toEqual([]);
  });

  it("falls back to the request origin when SHOPIFY_APP_URL is unset", async () => {
    const res = await loader({
      request: req("http://localhost:3000/cron/detect", "Bearer s3cret"),
    } as never);
    await res.json();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/api/engine/run",
      expect.anything(),
    );
  });
});
