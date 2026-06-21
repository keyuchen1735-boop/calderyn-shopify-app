import { describe, it, expect } from "vitest";
import { calibrationLabel } from "../CalibrationHeader";

describe("calibrationLabel", () => {
  it("returns calibrating string when pct is null", () => {
    expect(calibrationLabel(null)).toBe("Calibrating your agent");
  });

  it("returns 'Getting started' for low pct (0)", () => {
    expect(calibrationLabel(0)).toBe("Getting started");
  });

  it("returns 'Getting started' for low pct (49)", () => {
    expect(calibrationLabel(49)).toBe("Getting started");
  });

  it("returns 'Learning fast' for mid pct (50)", () => {
    expect(calibrationLabel(50)).toBe("Learning fast");
  });

  it("returns 'Learning fast' for mid pct (89)", () => {
    expect(calibrationLabel(89)).toBe("Learning fast");
  });

  it("returns 'Nearly autonomous' for high pct (90)", () => {
    expect(calibrationLabel(90)).toBe("Nearly autonomous");
  });

  it("returns 'Nearly autonomous' for high pct (100)", () => {
    expect(calibrationLabel(100)).toBe("Nearly autonomous");
  });
});
