import { describe, it, expect } from "vitest";
import { escapeHtml, markUrls, viewInBrowserUrl } from "../content";

describe("escapeHtml", () => {
  it("neutralizes HTML metacharacters", () => {
    expect(escapeHtml(`<script>alert("x")&'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;");
  });
});

describe("url helpers", () => {
  it("builds absolute mark URLs without double slashes", () => {
    expect(markUrls("https://app.x.com/")).toEqual({
      teal: "https://app.x.com/pilot-mark-teal.png",
      white: "https://app.x.com/pilot-mark-white.png",
    });
  });
  it("encodes view-in-browser params", () => {
    expect(viewInBrowserUrl("https://app.x.com", "Jane", "Jane's Goods")).toBe(
      "https://app.x.com/pilot?first_name=Jane&store_name=Jane%27s+Goods",
    );
  });
});
