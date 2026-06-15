import { describe, it, expect } from "vitest";
import { renderPilotEmail } from "../email.server";

const base = "https://app.calderyncompany.com";
const unsub = `${base}/pilot/unsubscribe?token=tok`;

describe("renderPilotEmail", () => {
  it("fills both merge fields, leaving no template placeholders", () => {
    const { html } = renderPilotEmail({ firstName: "Jane", storeName: "Acme", baseUrl: base, unsubscribeUrl: unsub });
    expect(html).not.toMatch(/\{\{.*?\}\}/);
    expect(html).toContain("Jane");
    expect(html).toContain("Acme");
  });
  it("uses absolute https logo URLs and the real install CTA", () => {
    const { html } = renderPilotEmail({ firstName: "Jane", storeName: "Acme", baseUrl: base, unsubscribeUrl: unsub });
    expect(html).toContain(`${base}/pilot-mark-teal.png`);
    expect(html).toContain(`${base}/pilot-mark-white.png`);
    expect(html).toContain("https://apps.shopify.com/calderynextension");
    expect(html).not.toContain("assets/calderyn-mark"); // no leftover local paths
  });
  it("wires view-in-browser + unsubscribe links", () => {
    const { html } = renderPilotEmail({ firstName: "Jane", storeName: "Acme", baseUrl: base, unsubscribeUrl: unsub });
    expect(html).toContain(`${base}/pilot?first_name=Jane`);
    expect(html).toContain(unsub);
  });
  it("escapes HTML in the fields and personalizes the subject", () => {
    const out = renderPilotEmail({ firstName: "<b>", storeName: "A&B", baseUrl: base, unsubscribeUrl: unsub });
    expect(out.html).toContain("&lt;b&gt;");
    expect(out.html).toContain("A&amp;B");
    expect(out.subject).toBe("You're in, <b> — your free Calderyn pilot");
    expect(out.text).toContain("https://apps.shopify.com/calderynextension");
  });
  it("falls back to generic copy when fields are blank", () => {
    const out = renderPilotEmail({ firstName: "", storeName: "", baseUrl: base, unsubscribeUrl: unsub });
    expect(out.subject).toBe("You're in — your free Calderyn pilot");
    expect(out.html).toContain("there");
    expect(out.html).toContain("your store");
  });
});
