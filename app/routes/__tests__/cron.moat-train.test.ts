import { describe, it, expect, vi, beforeEach } from "vitest";
import { loader } from "../cron.moat-train";

const { getSupabase } = vi.hoisted(() => ({
  getSupabase: vi.fn(() => ({})),
}));
const { acquireTrainLock, releaseTrainLock } = vi.hoisted(() => ({
  acquireTrainLock: vi.fn(() => Promise.resolve(true)),
  releaseTrainLock: vi.fn(() => Promise.resolve()),
}));

vi.mock("~/lib/supabase.server", () => ({ getSupabase }));
vi.mock("~/lib/moat/train-lock.server", () => ({ acquireTrainLock, releaseTrainLock }));

// The slice-#3 trainer success body (resolved contract): an `etl` summary object
// plus run counts, a per-shop `skipped` count, and an `errors[]`. Non-empty
// `errors[]` is a partial run (fail-visible), even on HTTP 200.
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
  return new Request("https://deployment-url.vercel.app/cron/moat-train", { headers });
}

describe("cron.moat-train loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    process.env.CRON_SECRET = "s3cret";
    acquireTrainLock.mockResolvedValue(true);
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
      "https://app.example.com/api/engine/moat-train",
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
    expect(releaseTrainLock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the request origin when SHOPIFY_APP_URL is unset", async () => {
    vi.stubEnv("SHOPIFY_APP_URL", "");
    const fetchMock = vi.fn().mockResolvedValue(
      trainerOk({ etl: ETL, shops_trained: 0, models_written: 0, skipped: 0, errors: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await loader({ request: req("Bearer s3cret") } as never);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://deployment-url.vercel.app/api/engine/moat-train",
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
    // Lock is always released even on failure, so the next night can run.
    expect(releaseTrainLock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a 503 (MOAT_PEPPER unconfigured) as a non-200 fail-visible response", async () => {
    // The trainer 503s when MOAT_PEPPER is unset; the cron must not report success.
    vi.stubEnv("SHOPIFY_APP_URL", "https://app.example.com");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "MOAT_PEPPER is not configured" }), {
        status: 503,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("503");
    expect(releaseTrainLock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a partial run (non-empty errors[]) as 500 with errors echoed", async () => {
    // Trainer returns HTTP 200 but reports per-shop skips. A partial cohort train
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
    expect(releaseTrainLock).toHaveBeenCalledTimes(1);
  });

  it("skips (200, no trainer call) when the lock is already held", async () => {
    vi.stubEnv("SHOPIFY_APP_URL", "https://app.example.com");
    acquireTrainLock.mockResolvedValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe("locked");
    expect(fetchMock).not.toHaveBeenCalled();
    // We declined to run, so there is nothing to release.
    expect(releaseTrainLock).not.toHaveBeenCalled();
  });
});
