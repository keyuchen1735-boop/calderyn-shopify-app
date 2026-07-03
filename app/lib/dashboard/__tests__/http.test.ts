import { describe, it, expect, beforeEach } from "vitest";
import { jsonError, jsonOk, requireSameOrigin, checkSameOrigin, wantsJson } from "../http.server";

beforeEach(() => {
  process.env.DASHBOARD_PUBLIC_URL = "https://calderyncompany.com";
  process.env.SHOPIFY_APP_URL = "https://app.calderyncompany.com";
  delete process.env.DASHBOARD_ALLOWED_ORIGINS;
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
  it("honours DASHBOARD_ALLOWED_ORIGINS extras", () => {
    process.env.DASHBOARD_ALLOWED_ORIGINS = "https://calderyn-test.vercel.app, https://other.example.com";
    expect(() => requireSameOrigin(req("https://calderyn-test.vercel.app"))).not.toThrow();
    expect(() => requireSameOrigin(req("https://other.example.com"))).not.toThrow();
    expect(() => requireSameOrigin(req("https://evil.com"))).toThrow();
  });
  it("skips malformed allowlist entries without taking mutations down", () => {
    process.env.DASHBOARD_PUBLIC_URL = ""; // prod regression: empty env must not 500
    process.env.DASHBOARD_ALLOWED_ORIGINS = "not a url,,https://ok.example.com";
    expect(() => requireSameOrigin(req("https://ok.example.com"))).not.toThrow();
    expect(() => requireSameOrigin(req("https://app.calderyncompany.com"))).not.toThrow();
  });
});

describe("checkSameOrigin (non-throwing form for page routes)", () => {
  it("returns null for an allowed origin and the 403 response for a foreign one", async () => {
    const ok = new Request("https://calderyncompany.com/dashboard/signin", {
      method: "POST",
      headers: { Origin: "https://calderyncompany.com" },
    });
    expect(checkSameOrigin(ok)).toBeNull();

    const bad = new Request("https://calderyncompany.com/dashboard/signin", {
      method: "POST",
      headers: { Origin: "https://evil.com" },
    });
    const res = checkSameOrigin(bad);
    expect(res?.status).toBe(403);
    expect((await res!.json()).error).toBe("bad_origin");
  });
});

describe("wantsJson", () => {
  it("detects fetch clients by Accept header", () => {
    const json = new Request("https://x.test/", { headers: { Accept: "application/json" } });
    const html = new Request("https://x.test/", { headers: { Accept: "text/html,application/xhtml+xml" } });
    const none = new Request("https://x.test/");
    expect(wantsJson(json)).toBe(true);
    expect(wantsJson(html)).toBe(false);
    expect(wantsJson(none)).toBe(false);
  });
});
