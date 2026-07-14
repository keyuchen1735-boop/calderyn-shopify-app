import { describe, expect, it } from "vitest";
import { STOREFRONT_REFERENCE_MEDIA_TYPES } from "./contracts";

describe("merchant reference media contract", () => {
  it("only advertises formats verified by the bounded owned-asset sniffer", () => {
    expect(STOREFRONT_REFERENCE_MEDIA_TYPES).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(STOREFRONT_REFERENCE_MEDIA_TYPES).not.toContain("image/avif");
  });
});
