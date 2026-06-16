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
  it("wires the real install CTA and ships no images (text-first, less promotional)", () => {
    const { html } = renderPilotEmail({ firstName: "Jane", storeName: "Acme", baseUrl: base, unsubscribeUrl: unsub });
    expect(html).toContain("https://apps.shopify.com/calderynextension");
    expect(html).not.toContain("assets/calderyn-mark"); // no leftover local paths
    // An image-free email reads as a personal note, not a marketing blast → Primary, not Promotions.
    expect(html).not.toMatch(/<img\b/);
    expect(html).not.toContain("pilot-mark-white.png");
  });
  it("omits the top bar — no header mark or Beta pilot tag", () => {
    const { html } = renderPilotEmail({ firstName: "Jane", storeName: "Acme", baseUrl: base, unsubscribeUrl: unsub });
    expect(html).not.toContain(`${base}/favicon.png`); // hex-C top-bar logo lived only in the removed top bar
    expect(html).not.toContain("Beta pilot");
  });
  it("wires view-in-browser + unsubscribe links", () => {
    const { html } = renderPilotEmail({ firstName: "Jane", storeName: "Acme", baseUrl: base, unsubscribeUrl: unsub });
    expect(html).toContain(`${base}/pilot?first_name=Jane`);
    expect(html).toContain(`${base}/pilot?first_name=Jane&amp;store_name=Acme`); // href encodes & as &amp;
    expect(html).toContain(unsub);
  });
  it("escapes HTML in the fields and personalizes the subject", () => {
    const out = renderPilotEmail({ firstName: "<b>", storeName: "A&B", baseUrl: base, unsubscribeUrl: unsub });
    expect(out.html).toContain("&lt;b&gt;");
    expect(out.html).toContain("A&amp;B");
    expect(out.subject).toBe("You're in, <b> — your free Calderyn pilot");
    expect(out.text).toContain("https://apps.shopify.com/calderynextension");
  });
  it("is a single fluid column at email width — robust without media queries", () => {
    const { html } = renderPilotEmail({ firstName: "Jane", storeName: "Acme", baseUrl: base, unsubscribeUrl: unsub });
    // One layout, not a desktop/mobile pair toggled by a query: clients that strip
    // <style>/media queries (e.g. Gmail on non-Google accounts) no longer crush a
    // two-column hero into the phone width.
    expect(html).not.toContain('class="cd-desk"');
    expect(html).not.toContain('class="cd-mob"');
    expect(html).toContain("max-width:600px"); // standard single-column email width
    expect(html).not.toContain("max-width:1100px");
  });
  it("falls back to generic copy when fields are blank", () => {
    const out = renderPilotEmail({ firstName: "", storeName: "", baseUrl: base, unsubscribeUrl: unsub });
    expect(out.subject).toBe("You're in — your free Calderyn pilot");
    expect(out.html).toContain("there");
    expect(out.html).toContain("your store");
  });
  it("includes the product-hook alert card (the 'Running ads for a sold-out product' demo)", () => {
    const { html } = renderPilotEmail({ firstName: "Jane", storeName: "Acme", baseUrl: base, unsubscribeUrl: unsub });
    expect(html).toContain("Running ads for a sold-out product");
    expect(html).toContain("Pause campaign");
    expect(html).toContain("$3,150");
  });
  it("keeps a single primary CTA — no second pill button competing with Install", () => {
    const { html } = renderPilotEmail({ firstName: "Jane", storeName: "Acme", baseUrl: base, unsubscribeUrl: unsub });
    // Feedback survives as a quiet inline text link, not a bordered button.
    expect(html).not.toContain("border:1.5px solid #24556E; border-radius:999px");
    expect(html).toContain("https://calderyncompany.com/pilot-feedback");
  });
  it("shows Install → Connect → Save as an arrow-linked step flow", () => {
    const { html } = renderPilotEmail({ firstName: "Jane", storeName: "Acme", baseUrl: base, unsubscribeUrl: unsub });
    expect(html).not.toContain("Get the text");
    // step labels in order, separated by arrows
    expect(html).toMatch(/>Install<[\s\S]*?&rarr;[\s\S]*?>Connect<[\s\S]*?&rarr;[\s\S]*?>Save</);
  });
});
