import { describe, it, expect, beforeEach } from "vitest";
import { jsonError, jsonOk, requireSameOrigin } from "../http.server";

beforeEach(() => {
  process.env.DASHBOARD_PUBLIC_URL = "https://calderyncompany.com";
  process.env.SHOPIFY_APP_URL = "https://app.calderyncompany.com";
});

describe("jsonOk / jsonError", () => {
  it("sets content type, no-store, and the error contract", async () => {
    const ok = jsonOk({ a: 1 });
    expect(ok.headers.get("Content-Type")).toContain("application/json");
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
    expect(await ok.json()).toEqual({ a: 1 });

    const err = jsonError(422, "invalid_shop", "Shop domain is malformed");
    expect(err.status).toBe(422);
    expect(await err.json()).toEqual({
      error: "invalid_shop",
      message: "Shop domain is malformed",
    });
  });
});

describe("requireSameOrigin", () => {
  function req(origin?: string) {
    return new Request("https://calderyncompany.com/dashboard/api/x", {
      method: "POST",
      headers: origin ? { Origin: origin } : {},
    });
  }
  it("allows the public and app origins", () => {
    expect(() => requireSameOrigin(req("https://calderyncompany.com"))).not.toThrow();
    expect(() => requireSameOrigin(req("https://app.calderyncompany.com"))).not.toThrow();
  });
  it("throws 403 for foreign or missing origins", () => {
    for (const r of [req("https://evil.com"), req()]) {
      try {
        requireSameOrigin(r);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect((e as Response).status).toBe(403);
      }
    }
  });
});
