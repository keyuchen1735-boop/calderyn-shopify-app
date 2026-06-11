import { describe, it, expect } from "vitest";
import { creativeInputFromJson, validateCreativeMedia } from "../media.server";
import type { CreativeInput } from "../types";

const base: CreativeInput = {
  imageUrl: null,
  headline: "h",
  primaryText: "p",
  cta: "SHOP_NOW",
  destinationUrl: "https://x.test/p",
  audience: "a",
};

describe("validateCreativeMedia", () => {
  it("rejects a manual input with no media at all", () => {
    expect(validateCreativeMedia(base)).toMatch(/drop its image or video/i);
    expect(validateCreativeMedia({ ...base, mediaKind: null })).toMatch(/image or video/i);
  });

  it("accepts an image with an imageUrl; rejects one without", () => {
    expect(
      validateCreativeMedia({ ...base, mediaKind: "image", imageUrl: "data:image/webp;base64,AA" }),
    ).toBeNull();
    expect(validateCreativeMedia({ ...base, mediaKind: "image" })).toMatch(/image/i);
  });

  it("accepts a video with frames; rejects one without", () => {
    expect(
      validateCreativeMedia({
        ...base,
        mediaKind: "video",
        imageUrl: "data:image/webp;base64,AA",
        videoFrameUrls: ["data:image/webp;base64,AA"],
      }),
    ).toBeNull();
    expect(validateCreativeMedia({ ...base, mediaKind: "video", videoFrameUrls: [] })).toMatch(
      /video/i,
    );
    expect(validateCreativeMedia({ ...base, mediaKind: "video" })).toMatch(/video/i);
  });
});

describe("creativeInputFromJson", () => {
  it("shapes a full video payload, trimming strings and filtering non-string frames", () => {
    const out = creativeInputFromJson({
      headline: "  Hi  ",
      primaryText: "body",
      cta: "",
      destinationUrl: "https://x.test/p",
      audience: "women 25-44",
      mediaKind: "video",
      imageUrl: "data:image/webp;base64,AA",
      videoFrameUrls: ["data:image/webp;base64,AA", 42, null, "data:image/webp;base64,BB"],
      videoDurationSec: 12.4,
    });
    expect(out.headline).toBe("Hi");
    expect(out.cta).toBe("SHOP_NOW");
    expect(out.mediaKind).toBe("video");
    expect(out.videoFrameUrls).toEqual([
      "data:image/webp;base64,AA",
      "data:image/webp;base64,BB",
    ]);
    expect(out.videoDurationSec).toBe(12.4);
  });

  it("nulls out an unknown mediaKind and bad duration; missing fields → ''", () => {
    const out = creativeInputFromJson({ mediaKind: "gif", videoDurationSec: "nope" });
    expect(out.mediaKind).toBeNull();
    expect(out.videoDurationSec).toBeNull();
    expect(out.videoFrameUrls).toEqual([]);
    expect(out.imageUrl).toBeNull();
    expect(out.headline).toBe("");
  });
});
