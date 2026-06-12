import { describe, it, expect, vi, beforeEach } from "vitest";
import { loader } from "../healthz";

// Mock the calderyn data-layer client so we can assert the shallow (public)
// path never touches it, and the deep (authenticated) path does.
const { calderynClient, alertsList, auditList, campaignsList, skusList, guardrailsGet } =
  vi.hoisted(() => {
    const alertsList = vi.fn().mockResolvedValue([]);
    const auditList = vi.fn().mockResolvedValue([]);
    const campaignsList = vi.fn().mockResolvedValue([]);
    const skusList = vi.fn().mockResolvedValue([]);
    const guardrailsGet = vi.fn().mockResolvedValue({});
    const calderynClient = vi.fn(() => ({
      alerts: { list: alertsList },
      audit: { list: auditList },
      campaigns: { list: campaignsList },
      skus: { list: skusList },
      guardrails: { get: guardrailsGet },
    }));
    return { calderynClient, alertsList, auditList, campaignsList, skusList, guardrailsGet };
  });

vi.mock("~/lib/calderyn.server", () => ({ calderynClient }));

function req(auth?: string): Request {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request("https://app.example.com/healthz", { headers });
}

describe("healthz loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "s3cret";
  });

  it("public unauthenticated GET is a shallow liveness probe", async () => {
    const res = await loader({ request: req() } as never);
    expect(res.status).toBe(200);
    const body = await res.json();

    // Body is exactly { ok: true } — no timing/reachability/error fields.
    expect(body).toEqual({ ok: true });
    expect(body).not.toHaveProperty("elapsed_ms");
    expect(body).not.toHaveProperty("checks");
    expect(body).not.toHaveProperty("errorCode");

    // The data layer must NOT be exercised on the public path.
    expect(calderynClient).not.toHaveBeenCalled();
    expect(alertsList).not.toHaveBeenCalled();
    expect(auditList).not.toHaveBeenCalled();
    expect(campaignsList).not.toHaveBeenCalled();
    expect(skusList).not.toHaveBeenCalled();
    expect(guardrailsGet).not.toHaveBeenCalled();
  });

  it("falls back to the shallow probe when the cron secret is wrong", async () => {
    const res = await loader({ request: req("Bearer wrong") } as never);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(calderynClient).not.toHaveBeenCalled();
  });

  it("runs the deep data-layer checks when the cron secret is presented", async () => {
    const res = await loader({ request: req("Bearer s3cret") } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      checks: { dataLayer: string };
      elapsed_ms: number;
    };

    // Deep mode exercises the five read paths and reports reachability + timing.
    expect(calderynClient).toHaveBeenCalled();
    expect(alertsList).toHaveBeenCalled();
    expect(auditList).toHaveBeenCalled();
    expect(campaignsList).toHaveBeenCalled();
    expect(skusList).toHaveBeenCalled();
    expect(guardrailsGet).toHaveBeenCalled();

    expect(body.ok).toBe(true);
    expect(body.checks).toEqual({ dataLayer: "reachable" });
    expect(body).toHaveProperty("elapsed_ms");
    expect(typeof body.elapsed_ms).toBe("number");
  });

  it("reports unreachable in deep mode when the data layer throws", async () => {
    alertsList.mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "PGRST" }));
    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = (await res.json()) as {
      ok: boolean;
      checks: { dataLayer: string };
      errorCode: string;
    };
    expect(body.ok).toBe(false);
    expect(body.checks).toEqual({ dataLayer: "unreachable" });
    expect(body.errorCode).toBe("PGRST");
  });
});
