import { describe, it, expect, afterEach } from "vitest";
import { appOrigin } from "../origin.server";

const ORIG = { ...process.env };
afterEach(() => { process.env = { ...ORIG }; });

describe("appOrigin", () => {
  it("prefers PUBLIC_APP_URL, stripping a trailing slash", () => {
    process.env.PUBLIC_APP_URL = "https://app.calderyncompany.com/";
    expect(appOrigin(new Request("https://whatever.test/x"))).toBe("https://app.calderyncompany.com");
  });
  it("falls back to the request origin when no env is set", () => {
    delete process.env.PUBLIC_APP_URL; delete process.env.SHOPIFY_APP_URL;
    expect(appOrigin(new Request("https://req.example/pilot"))).toBe("https://req.example");
  });
});
