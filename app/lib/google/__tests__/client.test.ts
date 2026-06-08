// app/lib/google/__tests__/client.test.ts
//
// Covers the searchStream error-detection logic. Google Ads' streaming
// endpoint returns errors EITHER as a bare `{ error }` object OR — because it
// streams — as a single-element array `[{ error }]`. Both must be recognised so
// a failed sync throws (rule 12) instead of being parsed as zero results and
// recorded as a clean, empty sync.

import { describe, it, expect } from "vitest";
import { extractAdsError, parseSearchStreamResponse } from "../client.server";

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

describe("parseSearchStreamResponse", () => {
  it("flattens results across batches on a successful (ok) response", () => {
    const raw = JSON.stringify([
      { results: [{ campaign: { id: "1" } }, { campaign: { id: "2" } }] },
      { results: [{ campaign: { id: "3" } }] },
    ]);
    expect(parseSearchStreamResponse(raw, true, 200)).toEqual([
      { campaign: { id: "1" } },
      { campaign: { id: "2" } },
      { campaign: { id: "3" } },
    ]);
  });

  it("throws a clear error (not an opaque JSON SyntaxError) on an HTML 404 from a sunset API version", () => {
    // The exact failure that flipped google_ads to sync_error: a sunset version
    // returns an HTML 404, and res.json() on it throws `Unexpected token '<'`.
    const html = '<!DOCTYPE html><html><head><title>404</title></head><body>Not Found</body></html>';
    expect(() => parseSearchStreamResponse(html, false, 404)).toThrow(/non-JSON response \(HTTP 404\)/);
    expect(() => parseSearchStreamResponse(html, false, 404)).not.toThrow(/Unexpected token/);
  });

  it("throws on an error-shaped body (array-wrapped streaming form)", () => {
    const raw = JSON.stringify([{ error: { message: "PERMISSION_DENIED" } }]);
    expect(() => parseSearchStreamResponse(raw, true, 200)).toThrow(/PERMISSION_DENIED/);
  });

  it("throws with the HTTP status on a non-ok JSON response with no error body", () => {
    expect(() => parseSearchStreamResponse(JSON.stringify([]), false, 500)).toThrow(/HTTP 500/);
  });
});
