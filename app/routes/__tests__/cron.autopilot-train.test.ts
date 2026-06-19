import { describe, it, expect, vi, beforeEach } from "vitest";
import { loader } from "../cron.autopilot-train";

const { getSupabase } = vi.hoisted(() => ({
  getSupabase: vi.fn(() => ({})),
}));

vi.mock("~/lib/supabase.server", () => ({ getSupabase }));

// The autopilot trainer success body: run counts and an errors[]. Non-empty
// errors[] is a partial run (fail-visible), even on HTTP 200.
const ETL = {
  alerts_projected: 120,
  baselines_written: 8,
  baselines_suppressed: 2,
  incidents_extracted: 14,
};

function trainerOk(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function req(auth?: string): Request {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request("https://deployment-url.vercel.app/cron/autopilot-train", { headers });
}

describe("cron.autopilot-train loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    process.env.CRON_SECRET = "s3cret";
  });

  it("rejects an unauthorized request and never invokes the trainer", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await loader({ request: req("Bearer wrong") } as never);

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when CRON_SECRET is unset and never invokes the trainer", async () => {
    // Fail closed: no configured secret means no caller can be authorized.
    delete process.env.CRON_SECRET;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await loader({ request: req("Bearer s3cret") } as never);

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invokes the trainer exactly once at the public origin with a Bearer + {} body and echoes its summary", async () => {
    vi.stubEnv("SHOPIFY_APP_URL", "https://app.example.com");
    const fetchMock = vi.fn().mockResolvedValue(
      trainerOk({
        etl: ETL,
        shops_trained: 12,
        models_written: 31,
        skipped: 3,
        errors: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.example.com/api/engine/autopilot-train",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer s3cret" }),
        body: "{}",
      }),
    );
    expect(body.ok).toBe(true);
    expect(body.etl).toEqual(ETL);
    expect(body.shops_trained).toBe(12);
    expect(body.models_written).toBe(31);
    expect(body.skipped).toBe(3);
    expect(body.errors).toEqual([]);
  });

  it("falls back to the request origin when SHOPIFY_APP_URL is unset", async () => {
    vi.stubEnv("SHOPIFY_APP_URL", "");
    const fetchMock = vi.fn().mockResolvedValue(
      trainerOk({ etl: ETL, shops_trained: 0, models_written: 0, skipped: 0, errors: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await loader({ request: req("Bearer s3cret") } as never);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://deployment-url.vercel.app/api/engine/autopilot-train",
      expect.anything(),
    );
  });

  it("surfaces a trainer transport failure as 502 and does not report success", async () => {
    vi.stubEnv("SHOPIFY_APP_URL", "https://app.example.com");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("Internal Error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("500");
  });

  it("surfaces a partial run (non-empty errors[]) as 500 with errors echoed", async () => {
    // Trainer returns HTTP 200 but reports per-shop errors. A partial cohort train
    // is a visible failure (rule 12): the route must NOT return 200 here.
    vi.stubEnv("SHOPIFY_APP_URL", "https://app.example.com");
    const fetchMock = vi.fn().mockResolvedValue(
      trainerOk({
        etl: ETL,
        shops_trained: 9,
        models_written: 20,
        skipped: 1,
        errors: ["pseudo-xyz: peer baseline below k=5"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.shops_trained).toBe(9);
    expect(body.errors).toEqual(["pseudo-xyz: peer baseline below k=5"]);
  });
});
