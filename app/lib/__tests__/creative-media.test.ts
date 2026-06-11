import { describe, it, expect } from "vitest";
import {
  frameTimestamps,
  mediaKindForFile,
  MEDIA_ACCEPT,
  VIDEO_FRAME_POSITIONS,
} from "../creative-media";

describe("mediaKindForFile", () => {
  it("classifies accepted image and video MIME types", () => {
    expect(mediaKindForFile("image/png")).toBe("image");
    expect(mediaKindForFile("image/webp")).toBe("image");
    expect(mediaKindForFile("video/mp4")).toBe("video");
    expect(mediaKindForFile("video/quicktime")).toBe("video");
  });
  it("rejects everything else (svg, gif, pdf, empty)", () => {
    expect(mediaKindForFile("image/svg+xml")).toBeNull();
    expect(mediaKindForFile("image/gif")).toBeNull();
    expect(mediaKindForFile("application/pdf")).toBeNull();
    expect(mediaKindForFile("")).toBeNull();
  });
  it("MEDIA_ACCEPT covers exactly the accepted types", () => {
    for (const t of MEDIA_ACCEPT.split(",")) {
      expect(mediaKindForFile(t)).not.toBeNull();
    }
  });
});

describe("frameTimestamps", () => {
  it("spreads positions across the duration, capped before the end", () => {
    const ts = frameTimestamps(30);
    expect(ts).toEqual(VIDEO_FRAME_POSITIONS.map((p) => 30 * p));
    expect(Math.max(...ts)).toBeLessThan(30);
  });
  it("collapses a sub-second clip to a single deduped timestamp", () => {
    expect(frameTimestamps(0.05)).toHaveLength(1);
  });
  it("falls back to [0] for NaN/Infinity/non-positive durations", () => {
    expect(frameTimestamps(NaN)).toEqual([0]);
    expect(frameTimestamps(Infinity)).toEqual([0]);
    expect(frameTimestamps(0)).toEqual([0]);
    expect(frameTimestamps(-3)).toEqual([0]);
  });
});
