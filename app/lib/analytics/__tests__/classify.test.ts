import { describe, it, expect } from "vitest";
import { gradeCampaign, GRADE_WIN_FACTOR, GRADE_OK_FACTOR } from "../classify";

describe("gradeCampaign", () => {
  const B = 2.0; // break-even ROAS

  it("grades comfortably-above as winning", () => {
    expect(gradeCampaign(2.5, B)).toBe("winning"); // 2.5 >= 1.2*2.0 = 2.4
  });

  it("grades exactly at the winning boundary as winning", () => {
    expect(gradeCampaign(GRADE_WIN_FACTOR * B, B)).toBe("winning");
  });

  it("grades just below winning as okay", () => {
    expect(gradeCampaign(2.39, B)).toBe("okay");
  });

  it("grades exactly at the okay boundary as okay", () => {
    expect(gradeCampaign(GRADE_OK_FACTOR * B, B)).toBe("okay"); // 1.9
  });

  it("grades just below break-even buffer as poor", () => {
    expect(gradeCampaign(1.89, B)).toBe("poor");
  });

  it("treats a non-positive break-even as poor unless roas is positive", () => {
    expect(gradeCampaign(0, 0)).toBe("poor");
    expect(gradeCampaign(1, 0)).toBe("winning");
  });
});
