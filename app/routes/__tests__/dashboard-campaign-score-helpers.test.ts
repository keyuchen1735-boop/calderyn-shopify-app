import { describe, it, expect } from "vitest";
import { parseScoreBody } from "../dashboard.api.campaigns.$id.score";
import { DEFAULT_SPEND_CENTS, MIN_SPEND_CENTS, MAX_SPEND_CENTS } from "~/lib/screener/types";

describe("parseScoreBody", () => {
  it("rejects a missing/blank adId", () => {
    expect(parseScoreBody({}).ok).toBe(false);
    expect(parseScoreBody({ adId: "   " }).ok).toBe(false);
  });

  it("builds a CreativeInput, coerces fields, defaults spend", () => {
    const r = parseScoreBody({ adId: "ad-1", headline: "H", primaryText: "P", cta: "BUY", destinationUrl: "https://x.test/p", audience: "a" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.adId).toBe("ad-1");
    expect(r.creative).toEqual({ imageUrl: null, headline: "H", primaryText: "P", cta: "BUY", destinationUrl: "https://x.test/p", audience: "a" });
    expect(r.assumedSpendCents).toBe(DEFAULT_SPEND_CENTS);
  });

  it('treats imageUrl "" and "null" as null, keeps a real url', () => {
    expect(parseScoreBody({ adId: "a", imageUrl: "" }).ok && (parseScoreBody({ adId: "a", imageUrl: "" }) as { creative: { imageUrl: string | null } }).creative.imageUrl).toBe(null);
    expect((parseScoreBody({ adId: "a", imageUrl: "null" }) as { creative: { imageUrl: string | null } }).creative.imageUrl).toBe(null);
    expect((parseScoreBody({ adId: "a", imageUrl: "https://img.test/x.png" }) as { creative: { imageUrl: string | null } }).creative.imageUrl).toBe("https://img.test/x.png");
  });

  it("clamps spend to [MIN, MAX]", () => {
    expect((parseScoreBody({ adId: "a", assumedSpendCents: 1 }) as { assumedSpendCents: number }).assumedSpendCents).toBe(MIN_SPEND_CENTS);
    expect((parseScoreBody({ adId: "a", assumedSpendCents: 99_999_999 }) as { assumedSpendCents: number }).assumedSpendCents).toBe(MAX_SPEND_CENTS);
  });
});
