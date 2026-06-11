// Money formatters must never render "$NaN"/"$undefined" to a merchant. Live
// rows can carry a missing/partial amount that coerces to a non-finite number;
// the guard collapses those to "$0" while leaving real values untouched.
import { describe, expect, it } from "vitest";
import { money, moneyK } from "../format";

describe("money", () => {
  it("formats whole and fractional cents", () => {
    expect(money(0)).toBe("$0");
    expect(money(100)).toBe("$1");
    expect(money(150)).toBe("$1.50");
    expect(money(123456)).toBe("$1,234.56");
    expect(money(-150)).toBe("-$1.50");
  });

  it("guards non-finite input instead of rendering $NaN", () => {
    expect(money(NaN)).toBe("$0");
    expect(money(Number.POSITIVE_INFINITY)).toBe("$0");
    // Values arriving as null/undefined despite the `number` type (partial rows).
    expect(money(undefined as unknown as number)).toBe("$0");
    expect(money(null as unknown as number)).toBe("$0");
  });
});

describe("moneyK", () => {
  it("abbreviates thousands and delegates below 1k", () => {
    expect(moneyK(500_00)).toBe("$500");
    expect(moneyK(1_234_56)).toBe("$1.2k");
    expect(moneyK(-1_500_00)).toBe("-$1.5k");
  });

  it("inherits the non-finite guard via money", () => {
    expect(moneyK(NaN)).toBe("$0");
  });
});
