import { describe, it, expect } from "vitest";
import { isAllowedMediaUrl, validateCreativeMediaUrls } from "../media.server";
import type { CreativeInput } from "../types";

const base: CreativeInput = {
  imageUrl: null,
  headline: "h",
  primaryText: "p",
  cta: "SHOP_NOW",
  destinationUrl: "https://x.test/p",
  audience: "a",
};

describe("isAllowedMediaUrl", () => {
  it("accepts a legitimate https CDN URL", () => {
    expect(isAllowedMediaUrl("https://cdn.example.com/a.jpg")).toBe(true);
  });

  it("accepts a client-produced data: image URL", () => {
    expect(isAllowedMediaUrl("data:image/webp;base64,AA")).toBe(true);
  });

  it("rejects the cloud metadata IP", () => {
    expect(isAllowedMediaUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    // even over https the link-local host must be rejected
    expect(isAllowedMediaUrl("https://169.254.169.254/latest/meta-data/")).toBe(false);
  });

  it("rejects localhost and loopback", () => {
    expect(isAllowedMediaUrl("http://localhost/x")).toBe(false);
    expect(isAllowedMediaUrl("https://localhost/x")).toBe(false);
    expect(isAllowedMediaUrl("https://127.0.0.1/x")).toBe(false);
    expect(isAllowedMediaUrl("https://[::1]/x")).toBe(false);
  });

  it("rejects private-range IP literals", () => {
    expect(isAllowedMediaUrl("https://10.0.0.5/x")).toBe(false);
    expect(isAllowedMediaUrl("https://192.168.1.1/x")).toBe(false);
    expect(isAllowedMediaUrl("https://172.16.0.1/x")).toBe(false);
  });

  it("rejects non-https remote schemes", () => {
    expect(isAllowedMediaUrl("http://cdn.example.com/a.jpg")).toBe(false);
    expect(isAllowedMediaUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedMediaUrl("gopher://example.com/x")).toBe(false);
  });

  it("rejects garbage / unparseable URLs", () => {
    expect(isAllowedMediaUrl("not a url")).toBe(false);
    expect(isAllowedMediaUrl("")).toBe(false);
  });

  it("rejects IPv4-mapped IPv6 literals that embed a private/metadata address", () => {
    // WHATWG URL normalizes these to ::ffff:<hex> — the embedded v4 must be decoded.
    expect(isAllowedMediaUrl("https://[::ffff:169.254.169.254]/latest/meta-data/")).toBe(false);
    expect(isAllowedMediaUrl("https://[::ffff:127.0.0.1]/x")).toBe(false);
    expect(isAllowedMediaUrl("https://[0:0:0:0:0:ffff:10.0.0.5]/x")).toBe(false);
    expect(isAllowedMediaUrl("https://[::ffff:192.168.1.1]/x")).toBe(false);
  });

  it("rejects NAT64-embedded private addresses", () => {
    expect(isAllowedMediaUrl("https://[64:ff9b::169.254.169.254]/x")).toBe(false);
  });

  it("rejects trailing-dot hostnames that bypass the literal checks", () => {
    expect(isAllowedMediaUrl("https://localhost./x")).toBe(false);
    expect(isAllowedMediaUrl("https://127.0.0.1./x")).toBe(false);
  });

  it("accepts a public IPv6 literal", () => {
    expect(isAllowedMediaUrl("https://[2606:4700:4700::1111]/x")).toBe(true);
  });

  it("rejects non-image and oversized data: URLs", () => {
    expect(isAllowedMediaUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isAllowedMediaUrl("data:application/json,{}")).toBe(false);
    const huge = "data:image/png;base64," + "A".repeat(13_000_000);
    expect(isAllowedMediaUrl(huge)).toBe(false);
  });
});

describe("validateCreativeMediaUrls", () => {
  it("passes a clean https image creative", () => {
    expect(
      validateCreativeMediaUrls({
        ...base,
        mediaKind: "image",
        imageUrl: "https://cdn.example.com/a.jpg",
      }),
    ).toBeNull();
  });

  it("passes a clean data: image creative", () => {
    expect(
      validateCreativeMediaUrls({
        ...base,
        mediaKind: "image",
        imageUrl: "data:image/webp;base64,AA",
      }),
    ).toBeNull();
  });

  it("rejects a metadata-IP imageUrl", () => {
    expect(
      validateCreativeMediaUrls({
        ...base,
        mediaKind: "image",
        imageUrl: "http://169.254.169.254/latest/meta-data/",
      }),
    ).toMatch(/url/i);
  });

  it("rejects a private IP inside videoFrameUrls", () => {
    expect(
      validateCreativeMediaUrls({
        ...base,
        mediaKind: "video",
        imageUrl: "https://cdn.example.com/poster.jpg",
        videoFrameUrls: [
          "https://cdn.example.com/f1.jpg",
          "https://192.168.1.1/f2.jpg",
        ],
      }),
    ).toMatch(/url/i);
  });

  it("passes clean videoFrameUrls", () => {
    expect(
      validateCreativeMediaUrls({
        ...base,
        mediaKind: "video",
        imageUrl: "data:image/webp;base64,AA",
        videoFrameUrls: ["data:image/webp;base64,AA", "https://cdn.example.com/f.jpg"],
      }),
    ).toBeNull();
  });

  it("ignores null imageUrl and absent frames (media presence is enforced elsewhere)", () => {
    expect(validateCreativeMediaUrls({ ...base, imageUrl: null })).toBeNull();
  });
});
