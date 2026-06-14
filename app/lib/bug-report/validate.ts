// app/lib/bug-report/validate.ts
//
// Pure validation for a bug report submission. No I/O, no secrets — shared by the
// embedded (Shopify) and dashboard surfaces, and trivially testable.

export const MAX_DESCRIPTION_CHARS = 5000;
export const MAX_EMAIL_CHARS = 320;
export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB
// Raster only. SVG is intentionally excluded (it can carry script -> stored XSS).
export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const ALLOWED_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];

export interface AttachmentMeta {
  filename: string;
  contentType: string;
  size: number;
}

export interface ValidatedBugReport {
  description: string;
  reporterEmail: string;
  attachments: AttachmentMeta[];
}

export type ValidationResult =
  | { ok: true; value: ValidatedBugReport }
  | { ok: false; code: string; message: string };

// Deliberately simple: one @, a dot in the domain, no spaces. A server-side
// guard, not a deliverability check — Resend is the real validator.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateBugReportInput(raw: {
  description: unknown;
  email: unknown;
  attachments: AttachmentMeta[];
}): ValidationResult {
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (!description) {
    return { ok: false, code: "EMPTY_DESCRIPTION", message: "Please describe the problem." };
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, code: "DESCRIPTION_TOO_LONG", message: "That description is too long." };
  }

  const reporterEmail = typeof raw.email === "string" ? raw.email.trim() : "";
  if (!reporterEmail) {
    return { ok: false, code: "EMPTY_EMAIL", message: "Please add an email so we can follow up." };
  }
  if (reporterEmail.length > MAX_EMAIL_CHARS || !EMAIL_RE.test(reporterEmail)) {
    return { ok: false, code: "INVALID_EMAIL", message: "That email doesn't look right." };
  }

  if (raw.attachments.length > MAX_ATTACHMENTS) {
    return { ok: false, code: "TOO_MANY_FILES", message: `Please attach at most ${MAX_ATTACHMENTS} images.` };
  }
  for (const a of raw.attachments) {
    if (a.size > MAX_ATTACHMENT_BYTES) {
      return { ok: false, code: "FILE_TOO_LARGE", message: "Each image must be 5 MB or smaller." };
    }
    const ext = a.filename.split(".").pop()?.toLowerCase() ?? "";
    const typeOk = (ALLOWED_IMAGE_TYPES as readonly string[]).includes(a.contentType.toLowerCase());
    const extOk = ALLOWED_EXTENSIONS.includes(ext);
    if (!typeOk || !extOk) {
      return { ok: false, code: "UNSUPPORTED_FILE", message: "Only PNG, JPG, GIF, or WebP images." };
    }
  }

  return { ok: true, value: { description, reporterEmail, attachments: raw.attachments } };
}
