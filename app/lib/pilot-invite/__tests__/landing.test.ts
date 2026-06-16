import { describe, it, expect } from "vitest";
import { renderPilotLanding } from "../landing.server";

const base = "https://app.calderyncompany.com";

describe("renderPilotLanding", () => {
  it("fills fields, leaves no placeholders, uses absolute logos + install CTA", () => {
    const html = renderPilotLanding({ firstName: "Jane", storeName: "Acme", baseUrl: base });
    expect(html).not.toMatch(/\{\{.*?\}\}/);
    expect(html).toContain("Jane");
    expect(html).toContain("Acme");
    expect(html).toContain(`${base}/pilot-mark-teal.png`);
    expect(html).toContain("https://apps.shopify.com/calderynextension");
    expect(html).not.toContain("Beta pilot"); // top nav removed
  });
  it("escapes HTML and falls back when blank", () => {
    const html = renderPilotLanding({ firstName: "<x>", storeName: "", baseUrl: base });
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("your store");
  });
});
