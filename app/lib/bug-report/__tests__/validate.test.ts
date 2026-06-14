import { describe, it, expect } from "vitest";
import { validateBugReportInput } from "../validate";

const ok = { description: "It broke", email: "me@store.com", attachments: [] };
const img = (over: Partial<{ filename: string; contentType: string; size: number }> = {}) => ({
  filename: over.filename ?? "shot.png",
  contentType: over.contentType ?? "image/png",
  size: over.size ?? 1000,
});

describe("validateBugReportInput", () => {
  it("accepts a valid report with no files", () => {
    const r = validateBugReportInput(ok);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.description).toBe("It broke");
      expect(r.value.reporterEmail).toBe("me@store.com");
    }
  });

  it("trims description and email", () => {
    const r = validateBugReportInput({ ...ok, description: "  hi  ", email: "  a@b.co  " });
    expect(r.ok && r.value.description).toBe("hi");
    expect(r.ok && r.value.reporterEmail).toBe("a@b.co");
  });

  it("rejects empty / whitespace description", () => {
    expect(validateBugReportInput({ ...ok, description: "   " })).toMatchObject({ ok: false, code: "EMPTY_DESCRIPTION" });
    expect(validateBugReportInput({ ...ok, description: 123 })).toMatchObject({ ok: false, code: "EMPTY_DESCRIPTION" });
  });

  it("rejects an over-long description", () => {
    expect(validateBugReportInput({ ...ok, description: "x".repeat(5001) })).toMatchObject({ ok: false, code: "DESCRIPTION_TOO_LONG" });
  });

  it("rejects missing / malformed email", () => {
    expect(validateBugReportInput({ ...ok, email: "" })).toMatchObject({ ok: false, code: "EMPTY_EMAIL" });
    expect(validateBugReportInput({ ...ok, email: "no-at" })).toMatchObject({ ok: false, code: "INVALID_EMAIL" });
    expect(validateBugReportInput({ ...ok, email: "a@b" })).toMatchObject({ ok: false, code: "INVALID_EMAIL" });
  });

  it("rejects more than 3 attachments", () => {
    expect(validateBugReportInput({ ...ok, attachments: [img(), img(), img(), img()] })).toMatchObject({ ok: false, code: "TOO_MANY_FILES" });
  });

  it("rejects files over 5 MB", () => {
    expect(validateBugReportInput({ ...ok, attachments: [img({ size: 5 * 1024 * 1024 + 1 })] })).toMatchObject({ ok: false, code: "FILE_TOO_LARGE" });
  });

  it("rejects SVG and other non-raster types", () => {
    expect(validateBugReportInput({ ...ok, attachments: [img({ filename: "x.svg", contentType: "image/svg+xml" })] })).toMatchObject({ ok: false, code: "UNSUPPORTED_FILE" });
    expect(validateBugReportInput({ ...ok, attachments: [img({ filename: "x.pdf", contentType: "application/pdf" })] })).toMatchObject({ ok: false, code: "UNSUPPORTED_FILE" });
  });

  it("rejects a content-type/extension mismatch", () => {
    expect(validateBugReportInput({ ...ok, attachments: [img({ filename: "x.svg", contentType: "image/png" })] })).toMatchObject({ ok: false, code: "UNSUPPORTED_FILE" });
  });

  it("accepts png/jpg/gif/webp", () => {
    const atts = [
      img({ filename: "a.png", contentType: "image/png" }),
      img({ filename: "b.jpg", contentType: "image/jpeg" }),
      img({ filename: "c.webp", contentType: "image/webp" }),
    ];
    expect(validateBugReportInput({ ...ok, attachments: atts })).toMatchObject({ ok: true });
  });
});
