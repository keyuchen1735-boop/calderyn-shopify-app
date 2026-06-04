// app/lib/google/__tests__/client.test.ts
//
// Covers the searchStream error-detection logic. Google Ads' streaming
// endpoint returns errors EITHER as a bare `{ error }` object OR — because it
// streams — as a single-element array `[{ error }]`. Both must be recognised so
// a failed sync throws (rule 12) instead of being parsed as zero results and
// recorded as a clean, empty sync.

import { describe, it, expect } from "vitest";
import { extractAdsError } from "../client.server";

describe("extractAdsError", () => {
  it("returns null for a successful (results) batch array", () => {
    expect(extractAdsError([{ results: [{ campaign: { id: "1" } }] }])).toBeNull();
  });

  it("returns null for an empty result array", () => {
    expect(extractAdsError([])).toBeNull();
  });

  it("detects a bare { error } body", () => {
    expect(extractAdsError({ error: { message: "invalid auth" } })).toBe("invalid auth");
  });

  it("detects the array-wrapped [{ error }] streaming form", () => {
    expect(extractAdsError([{ error: { message: "PERMISSION_DENIED" } }])).toBe(
      "PERMISSION_DENIED",
    );
  });

  it("falls back to a generic message when error has no message field", () => {
    expect(extractAdsError([{ error: {} }])).toBe("Google Ads API error");
  });
});
