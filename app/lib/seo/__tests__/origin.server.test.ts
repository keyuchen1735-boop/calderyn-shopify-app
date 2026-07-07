import { describe, it, expect } from "vitest";
import { storefrontOrigin } from "../origin.server";

function req(headers: Record<string, string>, url = "https://fallback.example/storefront"): Request {
  return new Request(url, { headers: new Headers(headers) });
}

describe("storefrontOrigin", () => {
  it("prefers x-forwarded-host + x-forwarded-proto (Vercel proxy)", () => {
    expect(storefrontOrigin(req({ "x-forwarded-host": "peakandpine.calderyncompany.com", "x-forwarded-proto": "https" })))
      .toBe("https://peakandpine.calderyncompany.com");
  });
  it("falls back to the host header as https", () => {
    expect(storefrontOrigin(req({ host: "ember.calderyncompany.com" }))).toBe("https://ember.calderyncompany.com");
  });
  it("uses http for localhost", () => {
    expect(storefrontOrigin(req({ host: "localhost:3000" }))).toBe("http://localhost:3000");
  });
  it("falls back to the request URL origin when no host header", () => {
    expect(storefrontOrigin(req({}, "https://fallback.example/storefront"))).toBe("https://fallback.example");
  });
});
