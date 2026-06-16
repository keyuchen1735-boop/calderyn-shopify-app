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
  it("uses an absolute https logo URL and the real install CTA", () => {
    const { html } = renderPilotEmail({ firstName: "Jane", storeName: "Acme", baseUrl: base, unsubscribeUrl: unsub });
    expect(html).toContain(`${base}/pilot-mark-white.png`);
    expect(html).toContain("https://apps.shopify.com/calderynextension");
    expect(html).not.toContain("assets/calderyn-mark"); // no leftover local paths
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
  it("ships a desktop (File 1) + mobile (File 2) layout toggled by a width media query", () => {
    const { html } = renderPilotEmail({ firstName: "Jane", storeName: "Acme", baseUrl: base, unsubscribeUrl: unsub });
    expect(html).toContain('class="cd-desk"');
    expect(html).toContain('class="cd-mob"');
    expect(html).toContain("@media only screen and (max-width:600px)");
    expect(html).toContain("max-width:1100px"); // desktop is fluid, fills up to ~1100px (File 1)
  });
  it("falls back to generic copy when fields are blank", () => {
    const out = renderPilotEmail({ firstName: "", storeName: "", baseUrl: base, unsubscribeUrl: unsub });
    expect(out.subject).toBe("You're in — your free Calderyn pilot");
    expect(out.html).toContain("there");
    expect(out.html).toContain("your store");
  });
  it("vertically centers the desktop hero alert card against the taller copy column", () => {
    const { html } = renderPilotEmail({ firstName: "Jane", storeName: "Acme", baseUrl: base, unsubscribeUrl: unsub });
    // right column (44%) holds the shorter alert card; middle-align so it sits centered
    expect(html).toContain('width="44%" style="vertical-align:middle;"');
  });
  it("shows Install → Connect → Save as an arrow-linked step flow", () => {
    const { html } = renderPilotEmail({ firstName: "Jane", storeName: "Acme", baseUrl: base, unsubscribeUrl: unsub });
    expect(html).not.toContain("Get the text");
    // step labels in order, separated by arrows
    expect(html).toMatch(/>Install<[\s\S]*?&rarr;[\s\S]*?>Connect<[\s\S]*?&rarr;[\s\S]*?>Save</);
  });
});
