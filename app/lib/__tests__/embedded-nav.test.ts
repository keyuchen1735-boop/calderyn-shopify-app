import { describe, expect, it } from "vitest";
import { appendEmbeddedSearch, ensureEmbeddedUrl } from "../embedded-nav";

const PARAMS = { shop: "test.myshopify.com", host: "YWRtaW4uc2hvcGlmeS5jb20" };
const ORIGIN = "https://app.calderyncompany.com";

describe("appendEmbeddedSearch", () => {
  it("appends shop, host, and embedded=1 to a bare path", () => {
    const out = appendEmbeddedSearch("/app/campaigns", PARAMS);
    const sp = new URLSearchParams(out.split("?")[1]);
    expect(out.startsWith("/app/campaigns?")).toBe(true);
    expect(sp.get("shop")).toBe("test.myshopify.com");
    expect(sp.get("host")).toBe("YWRtaW4uc2hvcGlmeS5jb20");
    expect(sp.get("embedded")).toBe("1");
  });

  it("preserves existing query params", () => {
    const out = appendEmbeddedSearch("/app/campaigns/abc?platform=TikTok", PARAMS);
    const sp = new URLSearchParams(out.split("?")[1]);
    expect(sp.get("platform")).toBe("TikTok");
    expect(sp.get("shop")).toBe("test.myshopify.com");
  });

  it("does not overwrite a shop/host already present in the target", () => {
    const out = appendEmbeddedSearch("/app?shop=other.myshopify.com", PARAMS);
    const sp = new URLSearchParams(out.split("?")[1]);
    expect(sp.get("shop")).toBe("other.myshopify.com");
    expect(sp.get("host")).toBe(PARAMS.host);
  });

  it("returns the path unchanged when no params are known", () => {
    expect(appendEmbeddedSearch("/app/alerts", { shop: null, host: null })).toBe("/app/alerts");
  });

  it("appends shop alone when host is unknown", () => {
    const out = appendEmbeddedSearch("/app", { shop: "test.myshopify.com", host: null });
    const sp = new URLSearchParams(out.split("?")[1]);
    expect(sp.get("shop")).toBe("test.myshopify.com");
    expect(sp.has("host")).toBe(false);
    expect(sp.get("embedded")).toBe("1");
  });

  it("leaves external URLs untouched", () => {
    expect(appendEmbeddedSearch("https://example.com/x", PARAMS)).toBe("https://example.com/x");
  });

  it("keeps a hash fragment after the appended params", () => {
    const out = appendEmbeddedSearch("/app/alerts#critical", PARAMS);
    expect(out.endsWith("#critical")).toBe(true);
    const sp = new URLSearchParams(out.slice(out.indexOf("?") + 1, out.indexOf("#")));
    expect(sp.get("shop")).toBe("test.myshopify.com");
    expect(sp.get("embedded")).toBe("1");
  });
});

describe("ensureEmbeddedUrl", () => {
  it("re-stocks shop/host/embedded onto a URL a client nav stripped bare", () => {
    const next = ensureEmbeddedUrl(`${ORIGIN}/app/campaigns`, PARAMS);
    expect(next).not.toBeNull();
    const sp = new URL(next!).searchParams;
    expect(sp.get("shop")).toBe("test.myshopify.com");
    expect(sp.get("host")).toBe("YWRtaW4uc2hvcGlmeS5jb20");
    expect(sp.get("embedded")).toBe("1");
  });

  it("returns null when nothing is missing (no needless replaceState)", () => {
    const href = `${ORIGIN}/app/campaigns?shop=test.myshopify.com&host=YWRtaW4uc2hvcGlmeS5jb20&embedded=1`;
    expect(ensureEmbeddedUrl(href, PARAMS)).toBeNull();
  });

  it("preserves the path and any unrelated params it adds onto", () => {
    const next = ensureEmbeddedUrl(`${ORIGIN}/app/campaigns/abc?platform=TikTok`, PARAMS);
    const url = new URL(next!);
    expect(url.pathname).toBe("/app/campaigns/abc");
    expect(url.searchParams.get("platform")).toBe("TikTok");
    expect(url.searchParams.get("shop")).toBe("test.myshopify.com");
  });

  it("does not overwrite a shop already on the URL", () => {
    const next = ensureEmbeddedUrl(`${ORIGIN}/app?shop=other.myshopify.com`, PARAMS);
    const sp = new URL(next!).searchParams;
    expect(sp.get("shop")).toBe("other.myshopify.com");
    expect(sp.get("host")).toBe(PARAMS.host);
  });

  it("adds shop alone (and embedded) when host is unknown", () => {
    const next = ensureEmbeddedUrl(`${ORIGIN}/app`, { shop: "test.myshopify.com", host: null });
    const sp = new URL(next!).searchParams;
    expect(sp.get("shop")).toBe("test.myshopify.com");
    expect(sp.has("host")).toBe(false);
    expect(sp.get("embedded")).toBe("1");
  });

  it("makes no change when no shop/host is known (never brands a bare URL embedded)", () => {
    expect(ensureEmbeddedUrl(`${ORIGIN}/app`, { shop: null, host: null })).toBeNull();
  });
});
