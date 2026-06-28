import { describe, it, expect, vi, afterEach } from "vitest";
import { basicAuthHeader, apiBase } from "../easypost.server";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── easypost.server shared HTTP helpers, exported for reuse by the rate adapter ──
describe("easypost.server exported helpers", () => {
  it("basicAuthHeader emits HTTP Basic with the key as username + empty password", () => {
    expect(basicAuthHeader("EZTKtest123")).toBe(
      `Basic ${Buffer.from("EZTKtest123:").toString("base64")}`,
    );
  });

  it("apiBase defaults to the production v2 base and strips a trailing slash from an override", () => {
    const prev = process.env.EASYPOST_API_BASE;
    delete process.env.EASYPOST_API_BASE;
    expect(apiBase()).toBe("https://api.easypost.com/v2");
    process.env.EASYPOST_API_BASE = "https://example.test/v2/";
    expect(apiBase()).toBe("https://example.test/v2");
    if (prev === undefined) delete process.env.EASYPOST_API_BASE;
    else process.env.EASYPOST_API_BASE = prev;
  });
});
