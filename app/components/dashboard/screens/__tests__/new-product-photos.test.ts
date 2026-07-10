import { describe, expect, it } from "vitest";
import { addPhotos, summarizePhotoRejections, PHOTO_MAX_BYTES, type PhotoDraft } from "../new-product-photos";

const makeUrl = (f: File) => `blob:${f.name}`;
const img = (name: string, bytes = 100, type = "image/png") =>
  new File([new Uint8Array(bytes)], name, { type });
const draft = (name: string): PhotoDraft => {
  const file = img(name);
  return { file, url: makeUrl(file) };
};

describe("addPhotos", () => {
  it("accepts valid files, preserving pick order", () => {
    const { next, rejected } = addPhotos([], [img("a.png"), img("b.png", 50, "image/webp")], 8, makeUrl);
    expect(rejected).toEqual([]);
    expect(next.map((p) => p.file.name)).toEqual(["a.png", "b.png"]);
    expect(next.map((p) => p.url)).toEqual(["blob:a.png", "blob:b.png"]);
  });

  it("appends after existing photos without touching them", () => {
    const cur = [draft("first.png")];
    const { next } = addPhotos(cur, [img("second.png")], 8, makeUrl);
    expect(next.map((p) => p.file.name)).toEqual(["first.png", "second.png"]);
    expect(next[0]).toBe(cur[0]);
    expect(cur).toHaveLength(1);
  });

  it("rejects unsupported types with reason type", () => {
    const { next, rejected } = addPhotos([], [img("doc.pdf", 100, "application/pdf"), img("ok.jpg", 100, "image/jpeg")], 8, makeUrl);
    expect(rejected).toEqual([{ name: "doc.pdf", reason: "type" }]);
    expect(next.map((p) => p.file.name)).toEqual(["ok.jpg"]);
  });

  it("rejects oversize files with reason size", () => {
    const { next, rejected } = addPhotos([], [img("huge.png", PHOTO_MAX_BYTES + 1)], 8, makeUrl);
    expect(rejected).toEqual([{ name: "huge.png", reason: "size" }]);
    expect(next).toEqual([]);
  });

  it("accepts a file exactly at the size cap", () => {
    const { next, rejected } = addPhotos([], [img("edge.png", PHOTO_MAX_BYTES)], 8, makeUrl);
    expect(rejected).toEqual([]);
    expect(next).toHaveLength(1);
  });

  it("rejects files past max with reason limit, keeping the ones that fit", () => {
    const cur = [draft("first.png")];
    const { next, rejected } = addPhotos(cur, [img("fits.png"), img("over.png")], 2, makeUrl);
    expect(next.map((p) => p.file.name)).toEqual(["first.png", "fits.png"]);
    expect(rejected).toEqual([{ name: "over.png", reason: "limit" }]);
  });

  it("reports type before limit when both apply", () => {
    const cur = [draft("first.png")];
    const { rejected } = addPhotos(cur, [img("bad.txt", 100, "text/plain")], 1, makeUrl);
    expect(rejected).toEqual([{ name: "bad.txt", reason: "type" }]);
  });
});

describe("summarizePhotoRejections", () => {
  it("returns null when nothing was rejected", () => {
    expect(summarizePhotoRejections([])).toBeNull();
  });

  it("summarizes a single shared reason", () => {
    expect(
      summarizePhotoRejections([
        { name: "a.png", reason: "size" },
        { name: "b.png", reason: "size" },
      ]),
    ).toBe("2 photos skipped (too large).");
    expect(summarizePhotoRejections([{ name: "a.pdf", reason: "type" }])).toBe(
      "1 photo skipped (unsupported type).",
    );
  });

  it("breaks down mixed reasons by count", () => {
    expect(
      summarizePhotoRejections([
        { name: "a.pdf", reason: "type" },
        { name: "b.png", reason: "size" },
        { name: "c.png", reason: "size" },
      ]),
    ).toBe("3 photos skipped (1 unsupported type, 2 too large).");
  });
});
