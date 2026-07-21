import { describe, expect, it } from "vitest";
import { expandCouponWidget, hasCouponWidget } from "./widgets";

const marker = '<div data-designer-widget="coupon" data-code="SAVE15" data-headline="15 off" data-sub="Join us."></div>';
const REDEEMABLE = ["SAVE15"];

describe("expandCouponWidget", () => {
  it("leaves html untouched and yields no extras when there is no marker", () => {
    const out = expandCouponWidget("<main>hi</main>", { preview: false });
    expect(out.html).toBe("<main>hi</main>");
    expect(out.css).toBe("");
    expect(out.script).toBe("");
  });

  it("expands the marker with the declared offer and returns the behavior script when live", () => {
    const out = expandCouponWidget(`<main>${marker}</main>`, { preview: false, redeemableCodes: REDEEMABLE });
    expect(out.html).not.toContain("data-designer-widget");
    expect(out.html).toContain("SAVE15");
    expect(out.html).toContain("15 off");
    expect(out.html).toContain("Join us.");
    expect(out.css).toContain(".cd-coupon");
    expect(out.script).toContain("data-cd-coupon");
  });

  it("omits the behavior script in preview (inert) and shows a preview note", () => {
    const out = expandCouponWidget(`<main>${marker}</main>`, { preview: true, redeemableCodes: REDEEMABLE });
    expect(out.script).toBe("");
    expect(out.html).toContain("Popup preview");
    expect(out.html).toContain('data-open="1"'); // visible inline, not a fixed overlay
  });

  // The honesty contract (spec D5): a code the platform cannot redeem must
  // never reach a shopper, and no discounts feature exists today — so with no
  // redeemable list at all, every marker vanishes.
  it("strips the marker entirely when no redeemable codes are supplied (fresh builds)", () => {
    const out = expandCouponWidget(`<main>${marker}</main>`, { preview: false });
    expect(out.html).toBe("<main></main>");
    expect(out.html).not.toContain("SAVE15");
    expect(out.css).toBe("");
    expect(out.script).toBe("");
  });

  it("strips a marker whose code is not in the redeemable list", () => {
    const out = expandCouponWidget(`<main>${marker}</main>`, { preview: true, redeemableCodes: ["OTHER20"] });
    expect(out.html).toBe("<main></main>");
    expect(out.css).toBe("");
  });

  it("strips a marker with no code at all — no invented fallback offer", () => {
    const out = expandCouponWidget('<div data-designer-widget="coupon"></div>', { preview: false, redeemableCodes: REDEEMABLE });
    expect(out.html).toBe("");
    expect(out.html).not.toContain("WELCOME10");
  });

  it("matches the redeemable code case-insensitively", () => {
    const out = expandCouponWidget(`<main>${marker}</main>`, { preview: false, redeemableCodes: ["save15"] });
    expect(out.html).toContain("SAVE15");
  });

  it("escapes offer text so a crafted value cannot inject markup", () => {
    const out = expandCouponWidget(
      '<div data-designer-widget="coupon" data-code="SAVE15" data-headline="&lt;img src=x&gt;"></div>',
      { preview: false, redeemableCodes: REDEEMABLE },
    );
    expect(out.html).not.toContain("<img src=x>");
  });

  it("detects the marker", () => {
    expect(hasCouponWidget(`x${marker}y`)).toBe(true);
    expect(hasCouponWidget("<div>no widget</div>")).toBe(false);
  });
});
