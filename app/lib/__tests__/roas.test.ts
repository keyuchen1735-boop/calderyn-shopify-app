import { describe, expect, test } from "vitest";
import { trueRoas } from "../roas";

const campaign = (
  spend_7d: number,
  roas_7d: number,
  contribution_margin: number,
) => ({ spend_7d, roas_7d, contribution_margin });

describe("trueRoas — spend-weighted, margin-adjusted blended ROAS", () => {
  test("weights each campaign's margin-adjusted ROAS by its 7d spend", () => {
    const result = trueRoas([
      campaign(100_000, 3, 0.5),
      campaign(50_000, 2, 0.4),
    ]);
    // (100000·3·0.5 + 50000·2·0.4) / 150000 = 190000 / 150000 ≈ 1.27 → "1.3×"
    expect(result).toBe("1.3×");
  });

  test("excludes campaigns missing spend, ROAS, or margin data", () => {
    const result = trueRoas([
      campaign(100_000, 3, 0.5),
      campaign(0, 9, 0.9), // no spend
      campaign(80_000, 0, 0.9), // no roas
      campaign(80_000, 9, 0), // no margin
    ]);
    // Only the first campaign qualifies: 3 · 0.5 = 1.5
    expect(result).toBe("1.5×");
  });

  test("returns an em dash when no campaign has usable data", () => {
    expect(trueRoas([])).toBe("—");
    expect(trueRoas([campaign(0, 0, 0)])).toBe("—");
  });
});
