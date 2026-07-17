import { describe, expect, it } from "vitest";
import { expandCouponWidget, hasCouponWidget } from "./widgets";

const marker = '<div data-designer-widget="coupon" data-code="SAVE15" data-headline="15 off" data-sub="Join us."></div>';

describe("expandCouponWidget", () => {
  it("leaves html untouched and yields no extras when there is no marker", () => {
    const out = expandCouponWidget("<main>hi</main>", { preview: false });
    expect(out.html).toBe("<main>hi</main>");
    expect(out.css).toBe("");
    expect(out.script).toBe("");
  });

  it("expands the marker with the declared offer and returns the behavior script when live", () => {
    const out = expandCouponWidget(`<main>${marker}</main>`, { preview: false });
    expect(out.html).not.toContain("data-designer-widget");
    expect(out.html).toContain("SAVE15");
    expect(out.html).toContain("15 off");
    expect(out.html).toContain("Join us.");
    expect(out.css).toContain(".cd-coupon");
    expect(out.script).toContain("data-cd-coupon");
  });

  it("omits the behavior script in preview (inert) and shows a preview note", () => {
    const out = expandCouponWidget(`<main>${marker}</main>`, { preview: true });
    expect(out.script).toBe("");
    expect(out.html).toContain("Popup preview");
    expect(out.html).toContain('data-open="1"'); // visible inline, not a fixed overlay
  });

  it("falls back to sane defaults when data attributes are missing", () => {
    const out = expandCouponWidget('<div data-designer-widget="coupon"></div>', { preview: false });
    expect(out.html).toContain("WELCOME10");
    expect(out.html).toContain("10% off your first order");
  });

  it("escapes offer text so a crafted value cannot inject markup", () => {
    const out = expandCouponWidget('<div data-designer-widget="coupon" data-headline="&lt;img src=x&gt;"></div>', { preview: false });
    expect(out.html).not.toContain("<img src=x>");
  });

  it("detects the marker", () => {
    expect(hasCouponWidget(`x${marker}y`)).toBe(true);
    expect(hasCouponWidget("<div>no widget</div>")).toBe(false);
  });
});
