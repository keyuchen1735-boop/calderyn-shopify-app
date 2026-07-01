import { describe, it, expect, vi, beforeEach } from "vitest";
import { loader } from "../cron.import";

const { drainImports } = vi.hoisted(() => ({
  drainImports: vi.fn(async () => ({ processed: 0 })),
}));
vi.mock("~/lib/import/run.server", () => ({ drainImports }));

function req(auth?: string): Request {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request("http://x/cron/import", { headers });
}

describe("cron.import loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "s3cret";
  });

  it("rejects an unauthorized request", async () => {
    const res = await loader({ request: req("Bearer wrong") } as never);
    expect(res.status).toBe(401);
    expect(drainImports).not.toHaveBeenCalled();
  });

  it("drains pending imports and reports the count", async () => {
    drainImports.mockResolvedValue({ processed: 2 });
    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(drainImports).toHaveBeenCalledOnce();
    expect(body.imports).toEqual({ processed: 2 });
    expect(body.importError).toBeNull();
  });

  it("records a drain failure in the summary instead of throwing", async () => {
    drainImports.mockRejectedValue(new Error("drain boom"));
    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.importError).toContain("drain boom");
    expect(body.imports).toEqual({ processed: 0 });
  });
});
