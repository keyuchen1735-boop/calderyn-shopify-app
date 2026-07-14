import { describe, it, expect } from "vitest";
import { parseFirstRunBody } from "../dashboard.api.campaigns.first-run";

function validBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runId: "11111111-1111-1111-1111-111111111111",
    productId: "22222222-2222-2222-2222-222222222222",
    budgetCents: 1500,
    placement: "facebook",
    creative: {
      headline: "Cozy socks, warm feet",
      primaryText: "Hand-knit wool socks for cold mornings.",
      cta: "SHOP_NOW",
      imageUrl: "https://cdn.example.com/socks.jpg",
      destinationUrl:
        "https://acme.calderyncompany.com/storefront/products/socks",
    },
    ...overrides,
  };
}

describe("parseFirstRunBody", () => {
  it("parses a valid body unchanged (in-range budget, in-range copy)", () => {
    const r = parseFirstRunBody(validBody());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.runId).toBe("11111111-1111-1111-1111-111111111111");
    expect(r.productId).toBe("22222222-2222-2222-2222-222222222222");
    expect(r.budgetCents).toBe(1500);
    expect(r.placement).toBe("facebook");
    expect(r.creative).toEqual({
      headline: "Cozy socks, warm feet",
      primaryText: "Hand-knit wool socks for cold mornings.",
      cta: "SHOP_NOW",
      imageUrl: "https://cdn.example.com/socks.jpg",
      destinationUrl:
        "https://acme.calderyncompany.com/storefront/products/socks",
    });
  });

  it("accepts either Meta publisher placement and keeps placement optional for older clients", () => {
    const instagram = parseFirstRunBody(validBody({ placement: "instagram" }));
    expect(instagram.ok).toBe(true);
    if (instagram.ok) expect(instagram.placement).toBe("instagram");

    const omitted = parseFirstRunBody(validBody({ placement: undefined }));
    expect(omitted.ok).toBe(true);
    if (omitted.ok) expect(omitted.placement).toBeNull();
  });

  it("rejects a non-Meta launch placement", () => {
    const r = parseFirstRunBody(validBody({ placement: "tiktok" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid_placement");
  });

  it("rejects a budget below the floor or above the ceiling", () => {
    const low = parseFirstRunBody(validBody({ budgetCents: 400 }));
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.error.code).toBe("budget_out_of_range");

    const high = parseFirstRunBody(validBody({ budgetCents: 25000 }));
    expect(high.ok).toBe(false);
    if (!high.ok) expect(high.error.code).toBe("budget_out_of_range");
  });

  it("accepts the budget boundaries themselves", () => {
    expect(parseFirstRunBody(validBody({ budgetCents: 500 })).ok).toBe(true);
    expect(parseFirstRunBody(validBody({ budgetCents: 20000 })).ok).toBe(true);
  });

  it("rejects a missing runId", () => {
    const r = parseFirstRunBody(validBody({ runId: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("missing_run_id");
  });

  it("rejects a missing productId", () => {
    const r = parseFirstRunBody(validBody({ productId: undefined }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("missing_product_id");
  });

  it("rejects malformed run and product IDs before they reach Postgres", () => {
    const badRun = parseFirstRunBody(validBody({ runId: "not-a-uuid" }));
    expect(badRun.ok).toBe(false);
    if (!badRun.ok) expect(badRun.error.code).toBe("invalid_run_id");

    const badProduct = parseFirstRunBody(validBody({ productId: "prod_1" }));
    expect(badProduct.ok).toBe(false);
    if (!badProduct.ok)
      expect(badProduct.error.code).toBe("invalid_product_id");
  });

  it("rejects a missing headline", () => {
    const r = parseFirstRunBody(
      validBody({
        creative: { ...(validBody().creative as object), headline: "  " },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("missing_headline");
  });

  it("rejects missing primary text", () => {
    const r = parseFirstRunBody(
      validBody({
        creative: { ...(validBody().creative as object), primaryText: "  " },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("missing_primary_text");
  });

  it("rejects a missing destinationUrl", () => {
    const r = parseFirstRunBody(
      validBody({
        creative: {
          ...(validBody().creative as object),
          destinationUrl: "not-a-url",
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("missing_destination_url");
  });

  it("rejects non-string fields (coerced to empty, hits the matching missing_* code)", () => {
    const runIdIsNumber = parseFirstRunBody(validBody({ runId: 12345 }));
    expect(runIdIsNumber.ok).toBe(false);
    if (!runIdIsNumber.ok)
      expect(runIdIsNumber.error.code).toBe("missing_run_id");

    const headlineIsNumber = parseFirstRunBody(
      validBody({
        creative: { ...(validBody().creative as object), headline: 42 },
      }),
    );
    expect(headlineIsNumber.ok).toBe(false);
    if (!headlineIsNumber.ok)
      expect(headlineIsNumber.error.code).toBe("missing_headline");
  });

  it("clamps headline to 40 chars and primaryText to 500 chars after trim", () => {
    const longHeadline = `  ${"a".repeat(60)}  `;
    const longPrimary = "b".repeat(600);
    const r = parseFirstRunBody(
      validBody({
        creative: {
          ...(validBody().creative as object),
          headline: longHeadline,
          primaryText: longPrimary,
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.creative.headline.length).toBe(40);
    expect(r.creative.primaryText.length).toBe(500);
  });

  it("defaults a blank cta to SHOP_NOW", () => {
    const r = parseFirstRunBody(
      validBody({
        creative: {
          ...(validBody().creative as object),
          cta: "  ",
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.creative.cta).toBe("SHOP_NOW");
  });

  it("requires an image before a campaign can be created", () => {
    const r = parseFirstRunBody(
      validBody({
        creative: { ...(validBody().creative as object), imageUrl: "" },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("missing_image_url");
  });

  it("rejects non-http creative image URLs", () => {
    const r = parseFirstRunBody(
      validBody({
        creative: {
          ...(validBody().creative as object),
          imageUrl: "data:image/png;base64,iVBORw0KGgo=",
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid_image_url");
  });

  it("normalizes cta to Meta's call_to_action enum (case/spaces) and whitelists it", () => {
    const cases: Array<[string, string]> = [
      ["Shop now", "SHOP_NOW"], // human casing + space → enum
      ["learn more", "LEARN_MORE"],
      ["SIGN_UP", "SIGN_UP"], // already-valid enum passes through
      ["nonsense", "SHOP_NOW"], // unrecognized → safe default
      ["Shop the summer sale!", "SHOP_NOW"], // AI free text → safe default
    ];
    for (const [input, expected] of cases) {
      const r = parseFirstRunBody(
        validBody({
          creative: { ...(validBody().creative as object), cta: input },
        }),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.creative.cta).toBe(expected);
    }
  });
});
