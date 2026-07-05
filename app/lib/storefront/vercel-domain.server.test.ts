import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerTenantDomain, tenantDomain } from "./vercel-domain.server";

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("VERCEL_TOKEN", "tok_test");
  vi.stubEnv("VERCEL_PROJECT_ID", "shopify-app");
  vi.stubEnv("VERCEL_TEAM_ID", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("tenantDomain", () => {
  it("builds the calderyncompany.com hostname from the slug", () => {
    expect(tenantDomain("peak-pine-a1b2c3")).toBe("peak-pine-a1b2c3.calderyncompany.com");
  });
});

describe("registerTenantDomain", () => {
  it("POSTs the domain to the project and reports success", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { name: "ok" }));
    await expect(registerTenantDomain("shop-abc123")).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.vercel.com/v10/projects/shopify-app/domains");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer tok_test");
    expect(JSON.parse(init.body)).toEqual({ name: "shop-abc123.calderyncompany.com" });
  });

  it("treats an already-registered domain as success", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, { error: { code: "domain_already_exists", message: "exists" } }),
    );
    await expect(registerTenantDomain("shop-abc123")).resolves.toBe(true);
  });

  it("returns false on a hard API failure without throwing", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, { error: { code: "forbidden", message: "nope" } }),
    );
    await expect(registerTenantDomain("shop-abc123")).resolves.toBe(false);
  });

  it("returns false on a network error without throwing", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    await expect(registerTenantDomain("shop-abc123")).resolves.toBe(false);
  });

  it("skips (returns false) when VERCEL_TOKEN is unset, without calling Vercel", async () => {
    vi.stubEnv("VERCEL_TOKEN", "");
    await expect(registerTenantDomain("shop-abc123")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
