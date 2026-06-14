# Report a Bug — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Report a bug" launcher (above "Ask Calderyn") on both the embedded Shopify app and the dashboard; a small form (description + email + up to 3 optional screenshots) that emails the team via Resend (reply-to the merchant) and saves a durable copy to Supabase.

**Architecture:** One shared server "brain" (`app/lib/bug-report/`) used by two thin routes and two native UIs — mirrors the existing "Ask Calderyn" assistant pattern. Validation is a pure function; orchestration (Storage upload → email → DB insert) never throws so a report is never lost. Email goes through a generic Resend sender extracted from the GitHub digest.

**Tech Stack:** Remix (Vite) resource routes, React 18 + Polaris (embedded) / custom `cd-*` CSS (dashboard), `@supabase/supabase-js@^2.106.1` (Postgres + Storage, service-role), Resend REST API, Vitest.

**Worktree:** All work happens in `C:/Users/famou/Desktop/calderyn-bug-report` (branch `feat/report-a-bug`). Run every command from that directory.

**Spec:** `docs/superpowers/specs/2026-06-14-report-a-bug-design.md`.

---

## File Structure

**New files**
- `app/lib/email/send.server.ts` — generic Resend sender (extracted from `github-digest/deliver.server.ts`; adds `replyTo` + `attachments`, `to` accepts an array). One responsibility: send one email.
- `app/lib/email/__tests__/send.server.test.ts` — payload-shape + never-throws tests (fetch mocked).
- `app/lib/bug-report/validate.ts` — pure validation + size/type/count limits. No I/O.
- `app/lib/bug-report/__tests__/validate.test.ts` — exhaustive validation tests.
- `app/lib/bug-report/submit.server.ts` — `parseBugReportForm` (FormData → validated input) + `submitBugReport` (Storage upload → email → DB insert).
- `app/lib/bug-report/__tests__/submit.server.test.ts` — orchestration tests (mocked Supabase + email).
- `app/routes/app.bug-report.tsx` — embedded resource route (POST multipart).
- `app/routes/dashboard.api.bug-report.tsx` — dashboard API route (POST multipart).
- `app/components/BugReport/BugReportButton.tsx` — Polaris launcher + modal.
- `app/components/BugReport/bug-report.css` — embedded launcher position.
- `app/components/dashboard/BugReportButton.tsx` — custom-CSS launcher + modal.
- `supabase/migrations/20260614120000_bug_report.sql` — `bug_report` table + RLS + `bug-reports` Storage bucket.

**Modified files**
- `app/lib/github-digest/run.server.ts` — import `sendEmail`/`DeliveryResult` from the new location.
- `app/lib/github-digest/deliver.server.ts` — **deleted** (moved).
- `app/routes/app.tsx` — import + mount `<BugReportButton />`; register `bug-report.css`.
- `app/components/dashboard/DashboardApp.tsx` — import + mount `<BugReportButton app={app} />`.
- `app/styles/dashboard.css` — dashboard launcher + modal styles.
- `.env.example` — document optional `BUG_REPORT_TO`.

---

## Task 1: Extract & generalize the Resend sender

**Files:**
- Create: `app/lib/email/send.server.ts`
- Test: `app/lib/email/__tests__/send.server.test.ts`
- Modify: `app/lib/github-digest/run.server.ts`
- Delete: `app/lib/github-digest/deliver.server.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/email/__tests__/send.server.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { sendEmail } from "../send.server";

afterEach(() => vi.restoreAllMocks());

describe("sendEmail", () => {
  it("posts to Resend with reply_to, array recipients, and base64 attachments", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "email_123" }), { status: 200 }));

    const out = await sendEmail({
      apiKey: "re_test",
      from: "Calderyn <bugs@calderyn.com>",
      to: ["a@x.com", "b@x.com"],
      replyTo: "merchant@store.com",
      subject: "Bug report",
      text: "something broke",
      attachments: [{ filename: "shot.png", content: "QUJD", contentType: "image/png" }],
    });

    expect(out).toEqual({ sent: true, id: "email_123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.to).toEqual(["a@x.com", "b@x.com"]);
    expect(body.reply_to).toBe("merchant@store.com");
    expect(body.attachments).toEqual([
      { filename: "shot.png", content: "QUJD", content_type: "image/png" },
    ]);
  });

  it("accepts a single string recipient (digest back-compat)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "e2" }), { status: 200 }));
    await sendEmail({ apiKey: "k", from: "f", to: "one@x.com", subject: "s", text: "t", cc: ["c@x.com"] });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.to).toEqual(["one@x.com"]);
    expect(body.cc).toEqual(["c@x.com"]);
    expect(body.reply_to).toBeUndefined();
  });

  it("returns a structured error (never throws) on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 422, statusText: "Unprocessable Entity" }),
    );
    const out = await sendEmail({ apiKey: "k", from: "f", to: "y@x.com", subject: "s", text: "t" });
    expect(out.sent).toBe(false);
    expect(out.error).toContain("Resend 422");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- send.server`
Expected: FAIL — `Cannot find module '../send.server'`.

- [ ] **Step 3: Create the sender**

Create `app/lib/email/send.server.ts`:

```ts
// app/lib/email/send.server.ts
//
// Generic transactional email via the Resend REST API (no SDK — one `fetch` to
// https://api.resend.com/emails). Extracted from github-digest/deliver.server.ts
// so multiple features (digest, bug reports) share one sender. Never throws;
// returns a structured result so callers can record a delivery failure (rule 12).

export interface EmailAttachment {
  filename: string;
  /** base64-encoded file content */
  content: string;
  contentType?: string;
}

export interface DeliveryResult {
  sent: boolean;
  id?: string;
  error?: string;
}

interface ResendOk {
  id: string;
}

export async function sendEmail(opts: {
  apiKey: string;
  from: string;
  to: string | string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachment[];
}): Promise<DeliveryResult> {
  try {
    const payload: Record<string, unknown> = {
      from: opts.from,
      to: Array.isArray(opts.to) ? opts.to : [opts.to],
      subject: opts.subject,
      text: opts.text,
    };
    if (opts.cc && opts.cc.length) payload.cc = opts.cc;
    if (opts.replyTo) payload.reply_to = opts.replyTo;
    if (opts.html) payload.html = opts.html;
    if (opts.attachments && opts.attachments.length) {
      payload.attachments = opts.attachments.map((a) => ({
        filename: a.filename,
        content: a.content,
        ...(a.contentType ? { content_type: a.contentType } : {}),
      }));
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { sent: false, error: `Resend ${res.status} ${res.statusText} ${detail.slice(0, 200)}` };
    }

    const data = (await res.json()) as ResendOk;
    return { sent: true, id: data?.id };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- send.server`
Expected: PASS (3 tests).

- [ ] **Step 5: Rewire the GitHub digest to the new sender**

In `app/lib/github-digest/run.server.ts`, replace the `deliverEmail` import and call.

Find the import of `deliverEmail`/`DeliveryResult` (currently from `./deliver.server`) and change it to:

```ts
import { sendEmail, type DeliveryResult } from "~/lib/email/send.server";
```

Find the call `deliverEmail({ apiKey, from, to, cc, subject: content.subject, text: content.text, html: content.html })` and change the function name only:

```ts
    delivery = await sendEmail({
      apiKey,
      from,
      to,
      cc,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });
```

(`to` is still a single string here — `sendEmail` wraps it. No other change.)

- [ ] **Step 6: Delete the old module and confirm nothing else imports it**

Run: `git rm app/lib/github-digest/deliver.server.ts`
Then search for stragglers — Run: `git grep -n "deliver.server" -- app` — Expected: no matches.

- [ ] **Step 7: Typecheck + full test suite**

Run: `npm run typecheck`
Expected: exit 0.
Run: `npm run test`
Expected: all pass (existing digest tests, if any, still green via the renamed call).

- [ ] **Step 8: Commit**

```bash
git add app/lib/email app/lib/github-digest/run.server.ts
git commit -m "lib/email: extract generic Resend sender (replyTo + attachments)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pure validation for a bug report

**Files:**
- Create: `app/lib/bug-report/validate.ts`
- Test: `app/lib/bug-report/__tests__/validate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/bug-report/__tests__/validate.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- validate`
Expected: FAIL — `Cannot find module '../validate'`.

- [ ] **Step 3: Implement the validator**

Create `app/lib/bug-report/validate.ts`:

```ts
// app/lib/bug-report/validate.ts
//
// Pure validation for a bug report submission. No I/O, no secrets — shared by the
// embedded (Shopify) and dashboard surfaces, and trivially testable.

export const MAX_DESCRIPTION_CHARS = 5000;
export const MAX_EMAIL_CHARS = 320;
export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB
// Raster only. SVG is intentionally excluded (it can carry script → stored XSS).
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
    const typeOk = (ALLOWED_IMAGE_TYPES as readonly string[]).includes(a.contentType);
    const extOk = ALLOWED_EXTENSIONS.includes(ext);
    if (!typeOk || !extOk) {
      return { ok: false, code: "UNSUPPORTED_FILE", message: "Only PNG, JPG, GIF, or WebP images." };
    }
  }

  return { ok: true, value: { description, reporterEmail, attachments: raw.attachments } };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- validate`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add app/lib/bug-report/validate.ts app/lib/bug-report/__tests__/validate.test.ts
git commit -m "lib/bug-report: pure submission validator (size/type/count limits)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Shared orchestration (parse + submit)

**Files:**
- Create: `app/lib/bug-report/submit.server.ts`
- Test: `app/lib/bug-report/__tests__/submit.server.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/bug-report/__tests__/submit.server.test.ts`. The mocks use relative specifiers (`../../supabase.server`, `../../email/send.server`) — both resolve to the same module `submit.server.ts` imports via `../supabase.server` / `../email/send.server` (matches the repo's existing `vi.mock` convention).

```ts
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { sendEmail } from "../../email/send.server";
import { submitBugReport } from "../submit.server";
import type { BugReportInput } from "../submit.server";

const inserted: Record<string, unknown>[] = [];
const uploads: { path: string; opts: unknown }[] = [];
let uploadError: { message: string } | null = null;

vi.mock("../../supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push(row);
        return Promise.resolve({ error: null });
      },
    }),
    storage: {
      from: () => ({
        upload: (path: string, _body: unknown, opts: unknown) => {
          uploads.push({ path, opts });
          return Promise.resolve({ data: uploadError ? null : { path }, error: uploadError });
        },
      }),
    },
  }),
  resolveShopId: vi.fn().mockResolvedValue("shop-uuid"),
}));

vi.mock("../../email/send.server", () => ({ sendEmail: vi.fn() }));

const baseInput = (): BugReportInput => ({
  shopDomain: "test.myshopify.com",
  surface: "app",
  reporterEmail: "merchant@store.com",
  description: "It broke",
  context: { screen: "/app/alerts", userAgent: "UA", submittedAt: "2026-06-14T00:00:00.000Z" },
  attachments: [
    { filename: "shot.png", contentType: "image/png", size: 3, bytes: new Uint8Array([65, 66, 67]) },
  ],
});

beforeEach(() => {
  inserted.length = 0;
  uploads.length = 0;
  uploadError = null;
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  process.env.DIGEST_FROM = "Calderyn <bugs@calderyn.com>";
  process.env.BUG_REPORT_TO = "a@x.com,b@x.com";
});

describe("submitBugReport", () => {
  it("uploads the screenshot, emails the team reply-to the merchant, and inserts a 'sent' row", async () => {
    (sendEmail as Mock).mockResolvedValue({ sent: true, id: "email_1" });
    const out = await submitBugReport(baseInput());

    expect(out.emailStatus).toBe("sent");
    expect(uploads).toHaveLength(1);
    expect(uploads[0].path).toMatch(/^test\.myshopify\.com\/[0-9a-f-]+\/0-shot\.png$/);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = (sendEmail as Mock).mock.calls[0][0];
    expect(arg.replyTo).toBe("merchant@store.com");
    expect(arg.to).toEqual(["a@x.com", "b@x.com"]);
    expect(arg.attachments[0]).toEqual({ filename: "shot.png", content: "QUJD", contentType: "image/png" });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      shop_id: "shop-uuid",
      shop_domain: "test.myshopify.com",
      reporter_email: "merchant@store.com",
      surface: "app",
      email_status: "sent",
      email_error: null,
    });
    expect((inserted[0].attachments as unknown[]).length).toBe(1);
  });

  it("still inserts a 'failed' row (with error) when the email send fails", async () => {
    (sendEmail as Mock).mockResolvedValue({ sent: false, error: "Resend 500" });
    const out = await submitBugReport(baseInput());
    expect(out.emailStatus).toBe("failed");
    expect(inserted[0]).toMatchObject({ email_status: "failed", email_error: "Resend 500" });
  });

  it("still emails (and records no stored attachment) when Storage upload fails", async () => {
    uploadError = { message: "bucket missing" };
    (sendEmail as Mock).mockResolvedValue({ sent: true, id: "e" });
    const out = await submitBugReport(baseInput());
    expect(out.emailStatus).toBe("sent");
    // Bytes still attached to the email…
    expect((sendEmail as Mock).mock.calls[0][0].attachments).toHaveLength(1);
    // …but nothing recorded as durably stored.
    expect(inserted[0].attachments).toEqual([]);
  });

  it("does not call sendEmail when email is not configured, and records the failure", async () => {
    delete process.env.RESEND_API_KEY;
    const out = await submitBugReport(baseInput());
    expect(sendEmail).not.toHaveBeenCalled();
    expect(out.emailStatus).toBe("failed");
    expect(inserted[0].email_status).toBe("failed");
    expect(String(inserted[0].email_error)).toContain("RESEND_API_KEY");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- submit.server`
Expected: FAIL — `Cannot find module '../submit.server'`.

- [ ] **Step 3: Implement parse + submit**

Create `app/lib/bug-report/submit.server.ts`:

```ts
// app/lib/bug-report/submit.server.ts
//
// The shared "brain" for a bug report. parseBugReportForm normalizes a multipart
// FormData (both surfaces post identical fields) into a validated input;
// submitBugReport uploads screenshots (best-effort), emails the team (reply-to the
// merchant), and persists the row with the real delivery status. It never throws
// on email/storage failure — the report is the priority.
import { getSupabase, resolveShopId } from "../supabase.server";
import { sendEmail, type EmailAttachment } from "../email/send.server";
import { validateBugReportInput, type AttachmentMeta } from "./validate";

export const BUG_REPORT_BUCKET = "bug-reports";

export interface BugReportContext {
  screen: string;
  userAgent: string;
  submittedAt: string;
}

export interface ParsedAttachment extends AttachmentMeta {
  bytes: Uint8Array;
}

export interface BugReportInput {
  shopDomain: string;
  surface: "app" | "dashboard";
  reporterEmail: string;
  description: string;
  context: BugReportContext;
  attachments: ParsedAttachment[];
}

export type ParseResult =
  | { ok: true; value: BugReportInput }
  | { ok: false; code: string; message: string };

export async function parseBugReportForm(
  form: FormData,
  opts: { shopDomain: string; surface: "app" | "dashboard"; userAgent: string },
): Promise<ParseResult> {
  const files = form
    .getAll("screenshots")
    .filter((f): f is File => f instanceof File && f.size > 0);
  const attachments: ParsedAttachment[] = [];
  for (const f of files) {
    attachments.push({
      filename: f.name,
      contentType: f.type,
      size: f.size,
      bytes: new Uint8Array(await f.arrayBuffer()),
    });
  }

  const validated = validateBugReportInput({
    description: form.get("description"),
    email: form.get("email"),
    attachments: attachments.map(({ filename, contentType, size }) => ({ filename, contentType, size })),
  });
  if (!validated.ok) return validated;

  const screenRaw = form.get("screen");
  return {
    ok: true,
    value: {
      shopDomain: opts.shopDomain,
      surface: opts.surface,
      reporterEmail: validated.value.reporterEmail,
      description: validated.value.description,
      context: {
        screen: typeof screenRaw === "string" ? screenRaw.slice(0, 200) : "",
        userAgent: opts.userAgent.slice(0, 400),
        submittedAt: new Date().toISOString(),
      },
      attachments,
    },
  };
}

function recipients(): { to: string[]; from?: string; apiKey?: string } {
  const explicit = (process.env.BUG_REPORT_TO || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fallback = [process.env.DIGEST_TO, ...(process.env.DIGEST_CC || "").split(",")]
    .map((s) => (s || "").trim())
    .filter(Boolean);
  return {
    to: explicit.length ? explicit : fallback,
    from: process.env.DIGEST_FROM,
    apiKey: process.env.RESEND_API_KEY,
  };
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "image";
}

function emailText(input: BugReportInput): string {
  return [
    input.description,
    "",
    "—",
    `Shop: ${input.shopDomain}`,
    `Surface: ${input.surface}`,
    `Screen: ${input.context.screen || "(unknown)"}`,
    `Reply to: ${input.reporterEmail}`,
    `User agent: ${input.context.userAgent || "(unknown)"}`,
    `Submitted: ${input.context.submittedAt}`,
  ].join("\n");
}

export interface SubmitResult {
  id: string;
  emailStatus: "sent" | "failed";
}

export async function submitBugReport(input: BugReportInput): Promise<SubmitResult> {
  const sb = getSupabase();
  const reportId = crypto.randomUUID();

  // 1. Screenshots: always attach the in-memory bytes to the email; best-effort
  //    persist a durable copy to the private Storage bucket.
  const emailAttachments: EmailAttachment[] = [];
  const stored: Array<{ path: string; filename: string; content_type: string; size_bytes: number }> = [];
  for (let i = 0; i < input.attachments.length; i++) {
    const a = input.attachments[i];
    emailAttachments.push({
      filename: a.filename,
      content: Buffer.from(a.bytes).toString("base64"),
      contentType: a.contentType,
    });
    const path = `${input.shopDomain}/${reportId}/${i}-${safeName(a.filename)}`;
    try {
      const { error } = await sb.storage
        .from(BUG_REPORT_BUCKET)
        .upload(path, a.bytes, { contentType: a.contentType, upsert: false });
      if (error) {
        console.error("[bug-report] storage upload failed", error.message);
      } else {
        stored.push({ path, filename: a.filename, content_type: a.contentType, size_bytes: a.size });
      }
    } catch (err) {
      console.error("[bug-report] storage upload threw", err);
    }
  }

  // 2. Email the team. sendEmail never throws.
  const { to, from, apiKey } = recipients();
  let delivery: { sent: boolean; error?: string };
  if (!apiKey || !from || to.length === 0) {
    const missing = [
      !apiKey && "RESEND_API_KEY",
      !from && "DIGEST_FROM",
      to.length === 0 && "BUG_REPORT_TO/DIGEST_TO",
    ]
      .filter(Boolean)
      .join(", ");
    delivery = { sent: false, error: `email not configured (${missing})` };
  } else {
    delivery = await sendEmail({
      apiKey,
      from,
      to,
      replyTo: input.reporterEmail,
      subject: `Bug report from ${input.shopDomain}`,
      text: emailText(input),
      attachments: emailAttachments,
    });
  }

  // 3. Persist with the true delivery status so a failed send is recoverable.
  const shopId = await resolveShopId(input.shopDomain);
  const { error: insertError } = await sb.from("bug_report").insert({
    id: reportId,
    shop_id: shopId,
    shop_domain: input.shopDomain,
    reporter_email: input.reporterEmail,
    description: input.description,
    surface: input.surface,
    context: input.context,
    attachments: stored,
    email_status: delivery.sent ? "sent" : "failed",
    email_error: delivery.sent ? null : delivery.error ?? "unknown",
  });
  if (insertError) {
    console.error("[bug-report] row insert failed", insertError.message);
  }

  return { id: reportId, emailStatus: delivery.sent ? "sent" : "failed" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- submit.server`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/lib/bug-report/submit.server.ts app/lib/bug-report/__tests__/submit.server.test.ts
git commit -m "lib/bug-report: shared parse + submit (storage upload, email, persist)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Database migration + Storage bucket

**Files:**
- Create: `supabase/migrations/20260614120000_bug_report.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260614120000_bug_report.sql`:

```sql
-- bug_report: merchant-submitted reports from the "Report a bug" launcher on both
-- surfaces (embedded Shopify app + dashboard). Each row is emailed to the team
-- (reply-to the merchant) and kept here as the durable record so a failed send is
-- never lost. Screenshots live in the private `bug-reports` storage bucket;
-- `attachments` records their object paths.
--
-- Shop-scoped via shop_id FK ON DELETE CASCADE to honour the GDPR-redact schema
-- invariant (every per-shop table cascades from shops). RLS on with no policy: the
-- app reaches this table only via the service-role key (which bypasses RLS);
-- anon/authenticated are denied. Mirrors the oauth_state / integration_credentials
-- convention.

create table if not exists public.bug_report (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  shop_id        uuid not null references shops(id) on delete cascade,
  shop_domain    text not null,
  reporter_email text not null,
  description    text not null,
  surface        text not null,
  context        jsonb not null default '{}'::jsonb,
  attachments    jsonb not null default '[]'::jsonb,
  email_status   text not null,
  email_error    text
);

create index if not exists bug_report_shop_idx on public.bug_report (shop_id, created_at desc);

alter table public.bug_report enable row level security;
revoke all on table public.bug_report from anon, authenticated;

-- Private bucket for screenshots. Service-role uploads bypass Storage RLS; with no
-- storage.objects policy for this bucket, anon/authenticated cannot read it.
insert into storage.buckets (id, name, public)
values ('bug-reports', 'bug-reports', false)
on conflict (id) do nothing;
```

- [ ] **Step 2: Apply the migration to the prod Supabase project**

Use the Supabase MCP tool `mcp__supabase__apply_migration` with `project_id: "ajgrmnvzxfxxlwrxcgnu"`, `name: "bug_report"`, and the SQL above. (Fallback: `supabase db push`, or paste into the Supabase SQL editor.)

- [ ] **Step 3: Verify the table and bucket exist**

Use `mcp__supabase__list_tables` (project `ajgrmnvzxfxxlwrxcgnu`, schema `public`) and confirm `bug_report` is present with the columns above.
Use `mcp__supabase__execute_sql` with `select id, public from storage.buckets where id = 'bug-reports';` and confirm one row with `public = false`.
Expected: both present.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260614120000_bug_report.sql
git commit -m "supabase: bug_report table + private bug-reports bucket (RLS deny-all)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Embedded resource route

**Files:**
- Create: `app/routes/app.bug-report.tsx`

- [ ] **Step 1: Create the route**

Create `app/routes/app.bug-report.tsx`:

```tsx
// app/routes/app.bug-report.tsx
// Resource route (no UI): backend for the embedded "Report a bug" launcher.
// POST multipart form-data { description, email, screen, screenshots[] }.
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { parseBugReportForm, submitBugReport } from "~/lib/bug-report/submit.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const parsed = await parseBugReportForm(form, {
    shopDomain: session.shop,
    surface: "app",
    userAgent: request.headers.get("user-agent") ?? "",
  });
  if (!parsed.ok) {
    return json({ error: { code: parsed.code, message: parsed.message } }, { status: 422 });
  }
  const result = await submitBugReport(parsed.value);
  return json({ ok: true, emailStatus: result.emailStatus });
};
```

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck`
Expected: exit 0.
Run: `npm run build`
Expected: exit 0 (the new route is picked up by fs-routes).

- [ ] **Step 3: Commit**

```bash
git add app/routes/app.bug-report.tsx
git commit -m "routes/app.bug-report: embedded bug-report action" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Embedded UI (Polaris launcher + modal) and mount

**Files:**
- Create: `app/components/BugReport/BugReportButton.tsx`
- Create: `app/components/BugReport/bug-report.css`
- Modify: `app/routes/app.tsx`

- [ ] **Step 1: Create the launcher CSS**

Create `app/components/BugReport/bug-report.css`:

```css
/* Stacks directly above the Ask Calderyn launcher (.calderyn-assistant-launcher
   sits at right:20px; bottom:20px). Same right edge + z-index lane. */
.calderyn-bugreport-launcher {
  position: fixed;
  right: 20px;
  bottom: 68px;
  z-index: 519;
}
```

- [ ] **Step 2: Create the component**

Create `app/components/BugReport/BugReportButton.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Banner,
  BlockStack,
  Button,
  DropZone,
  InlineStack,
  Modal,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";

const MAX_FILES = 3;
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ["image/png", "image/jpeg", "image/gif", "image/webp"];

type ActionData = { ok?: boolean; emailStatus?: string; error?: { code: string; message: string } };

export function BugReportButton() {
  const shopify = useAppBridge();
  const fetcher = useFetcher<ActionData>();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [email, setEmail] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const handledRef = useRef(false);

  const submitting = fetcher.state !== "idle";

  const reset = () => {
    setDescription("");
    setEmail("");
    setFiles([]);
    setFileError(null);
  };

  // Close + toast once per successful submit.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && !handledRef.current) {
      handledRef.current = true;
      setOpen(false);
      reset();
      shopify.toast.show("Thanks — your bug report was sent.");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const onDrop = useCallback((_dropped: File[], accepted: File[], rejected: File[]) => {
    setFileError(null);
    const next: File[] = [];
    for (const f of accepted) {
      if (!ALLOWED.includes(f.type)) {
        setFileError("Only PNG, JPG, GIF, or WebP images.");
        continue;
      }
      if (f.size > MAX_BYTES) {
        setFileError("Each image must be 5 MB or smaller.");
        continue;
      }
      next.push(f);
    }
    if (rejected.length) setFileError("Only PNG, JPG, GIF, or WebP images.");
    setFiles((prev) => [...prev, ...next].slice(0, MAX_FILES));
  }, []);

  const removeFile = (idx: number) => setFiles((prev) => prev.filter((_, i) => i !== idx));

  const submit = () => {
    handledRef.current = false;
    const fd = new FormData();
    fd.set("description", description);
    fd.set("email", email);
    fd.set("screen", typeof window !== "undefined" ? window.location.pathname : "");
    for (const f of files) fd.append("screenshots", f, f.name);
    fetcher.submit(fd, { method: "post", action: "/app/bug-report", encType: "multipart/form-data" });
  };

  const actionError = fetcher.data?.error?.message;
  const canSubmit = description.trim().length > 0 && email.trim().length > 0 && !submitting;

  return (
    <>
      <div className="calderyn-bugreport-launcher">
        <Button onClick={() => setOpen(true)}>Report a bug</Button>
      </div>
      <Modal
        open={open}
        onClose={() => {
          if (!submitting) setOpen(false);
        }}
        title="Report a bug"
        primaryAction={{ content: "Send report", onAction: submit, loading: submitting, disabled: !canSubmit }}
        secondaryActions={[{ content: "Cancel", onAction: () => setOpen(false), disabled: submitting }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {actionError && <Banner tone="critical">{actionError}</Banner>}
            <TextField
              label="What went wrong?"
              value={description}
              onChange={setDescription}
              multiline={4}
              autoComplete="off"
              maxLength={5000}
              placeholder="Tell us what happened and what you expected."
            />
            <TextField
              label="Your email (so we can follow up)"
              type="email"
              value={email}
              onChange={setEmail}
              autoComplete="email"
              placeholder="you@store.com"
            />
            <BlockStack gap="200">
              <Text as="span" variant="bodyMd">
                Screenshots (optional)
              </Text>
              <DropZone accept="image/*" type="image" onDrop={onDrop} allowMultiple>
                <DropZone.FileUpload
                  actionTitle="Add images"
                  actionHint="PNG, JPG, GIF or WebP — up to 5 MB each, 3 max"
                />
              </DropZone>
              {fileError && (
                <Text as="span" tone="critical" variant="bodySm">
                  {fileError}
                </Text>
              )}
              {files.length > 0 && (
                <InlineStack gap="200">
                  {files.map((f, i) => (
                    <InlineStack key={`${f.name}-${i}`} gap="100" blockAlign="center">
                      <Thumbnail size="small" alt={f.name} source={window.URL.createObjectURL(f)} />
                      <Button
                        variant="plain"
                        tone="critical"
                        onClick={() => removeFile(i)}
                        accessibilityLabel={`Remove ${f.name}`}
                      >
                        Remove
                      </Button>
                    </InlineStack>
                  ))}
                </InlineStack>
              )}
            </BlockStack>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </>
  );
}
```

- [ ] **Step 3: Mount it in `app/routes/app.tsx`**

Add the CSS `?url` import next to the other style imports (after the `assistantStyles` line):

```tsx
import bugReportStyles from "../components/BugReport/bug-report.css?url";
```

Add the component import next to `AssistantSlideout`:

```tsx
import { BugReportButton } from "../components/BugReport/BugReportButton";
```

Add a `links` entry after the `assistantStyles` stylesheet entry:

```tsx
  { rel: "stylesheet", href: bugReportStyles },
```

Mount it directly after `<AssistantSlideout />` (inside `<AppProvider>`):

```tsx
        <Outlet />
        <AssistantSlideout />
        <BugReportButton />
      </AppProvider>
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck`
Expected: exit 0.
Run: `npm run build`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/components/BugReport app/routes/app.tsx
git commit -m "components/BugReport: embedded launcher + modal (Polaris), mount in app shell" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Dashboard API route

**Files:**
- Create: `app/routes/dashboard.api.bug-report.tsx`

- [ ] **Step 1: Create the route**

Create `app/routes/dashboard.api.bug-report.tsx`:

```tsx
// app/routes/dashboard.api.bug-report.tsx
// POST multipart form-data { description, email, screen, screenshots[] } → files
// the bug report (email + durable row). Dashboard cookie auth + same-origin CSRF
// guard, mirroring dashboard.api.assistant.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { parseBugReportForm, submitBugReport } from "~/lib/bug-report/submit.server";

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(422, "invalid_form");
  }

  const parsed = await parseBugReportForm(form, {
    shopDomain: session.shopDomain,
    surface: "dashboard",
    userAgent: request.headers.get("user-agent") ?? "",
  });
  if (!parsed.ok) return jsonError(422, parsed.code.toLowerCase(), parsed.message);

  return dashboardJson(async () => {
    const result = await submitBugReport(parsed.value);
    return { ok: true, id: result.id, email_status: result.emailStatus };
  });
}
```

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck`
Expected: exit 0.
Run: `npm run build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/routes/dashboard.api.bug-report.tsx
git commit -m "routes/dashboard.api.bug-report: dashboard bug-report action" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Dashboard UI (custom launcher + modal) and mount

**Files:**
- Create: `app/components/dashboard/BugReportButton.tsx`
- Modify: `app/styles/dashboard.css`
- Modify: `app/components/dashboard/DashboardApp.tsx`

- [ ] **Step 1: Append styles to `app/styles/dashboard.css`**

Add at the end of the file:

```css
  /* ============ report-a-bug ============ */
  /* Launcher stacks above the Ask Calderyn launcher (which sits at bottom:84px). */
  .cd-bug-launcher {
    position: fixed; right: 20px; bottom: 140px; z-index: 59;
    display: inline-flex; align-items: center; gap: 8px;
    border: none; cursor: pointer; font-family: inherit;
    background: var(--card-solid); color: var(--text-1);
    font-size: 13px; font-weight: 600; letter-spacing: -0.008em;
    padding: 9px 15px; border-radius: 999px;
    box-shadow: var(--shadow-pop);
    transition: transform 0.15s ease, opacity 0.15s ease;
  }
  .cd-bug-launcher:hover { transform: translateY(-1px); opacity: 0.94; }

  .cd-bug-overlay {
    position: fixed; inset: 0; z-index: 80;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.32); padding: 16px;
  }
  .cd-bug-modal {
    width: 460px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px);
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--card-solid); border-radius: var(--radius);
    box-shadow: var(--shadow-pop);
  }
  .cd-bug-body { padding: 16px; display: flex; flex-direction: column; gap: 14px; overflow-y: auto; }
  .cd-bug-foot {
    display: flex; justify-content: flex-end; gap: 8px;
    padding: 12px 16px; border-top: 0.5px solid var(--hairline-strong);
  }
  .cd-bug-thumbs { display: flex; flex-wrap: wrap; gap: 8px; }
  .cd-bug-thumb { position: relative; width: 56px; height: 56px; border-radius: 8px; overflow: hidden; }
  .cd-bug-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .cd-bug-thumb button {
    position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; border-radius: 50%;
    border: none; cursor: pointer; background: rgba(0, 0, 0, 0.6); color: #fff; font-size: 12px; line-height: 1;
  }
```

- [ ] **Step 2: Create the component**

Create `app/components/dashboard/BugReportButton.tsx`:

```tsx
// Calderyn DashV2 — "Report a bug": floating launcher + modal, rendered with the
// dashboard's own cd-* design system. POSTs multipart form-data to
// /dashboard/api/bug-report (same shared brain as the embedded app).
import { useCallback, useRef, useState } from "react";

import { CDIcon } from "./icons";
import { Btn } from "./ui";
import type { DashboardCtx } from "./context";

const MAX_FILES = 3;
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export default function BugReportButton({ app }: { app: DashboardCtx }) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [email, setEmail] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const reset = () => {
    setDescription("");
    setEmail("");
    setFiles([]);
    setError(null);
  };

  const addFiles = useCallback((picked: FileList | null) => {
    if (!picked) return;
    setError(null);
    const next: File[] = [];
    for (const f of Array.from(picked)) {
      if (!ALLOWED.includes(f.type)) {
        setError("Only PNG, JPG, GIF, or WebP images.");
        continue;
      }
      if (f.size > MAX_BYTES) {
        setError("Each image must be 5 MB or smaller.");
        continue;
      }
      next.push(f);
    }
    setFiles((prev) => [...prev, ...next].slice(0, MAX_FILES));
  }, []);

  const removeFile = (i: number) => setFiles((prev) => prev.filter((_, idx) => idx !== i));

  // Active dashboard screen for context; nav's exact type is opaque here, so guard it.
  const navVal = (app as { nav?: unknown }).nav;
  const screen = typeof navVal === "string" ? navVal : "dashboard";

  const submit = async () => {
    if (!description.trim() || !email.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("description", description);
      fd.set("email", email);
      fd.set("screen", screen);
      for (const f of files) fd.append("screenshots", f, f.name);
      // No explicit Content-Type: the browser sets the multipart boundary. The
      // browser also sends Origin on same-origin POST, satisfying requireSameOrigin.
      const res = await fetch("/dashboard/api/bug-report", {
        method: "POST",
        credentials: "same-origin",
        body: fd,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(body.message ?? body.error ?? "Could not send the report.");
      }
      app.toast("Thanks — your bug report was sent.", "check");
      setOpen(false);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the report.");
    } finally {
      setSending(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="cd-bug-launcher" onClick={() => setOpen(true)} aria-label="Report a bug">
        <CDIcon name="warn" size={16} strokeWidth={1.9} />
        <span>Report a bug</span>
      </button>
    );
  }

  return (
    <div className="cd-bug-overlay" role="dialog" aria-label="Report a bug" aria-modal="true">
      <div className="cd-bug-modal">
        <div className="cd-chat-head">
          <div className="cd-chat-head-title">
            <div className="cd-h3">Report a bug</div>
          </div>
          <button
            type="button"
            className="cd-chat-close"
            aria-label="Close"
            onClick={() => !sending && setOpen(false)}
          >
            <CDIcon name="x" size={16} strokeWidth={2} />
          </button>
        </div>
        <div className="cd-bug-body">
          <label className="cd-field">
            <span>What went wrong?</span>
            <textarea
              className="cd-input"
              rows={4}
              maxLength={5000}
              placeholder="Tell us what happened and what you expected."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className="cd-field">
            <span>Your email (so we can follow up)</span>
            <input
              className="cd-input"
              type="email"
              placeholder="you@store.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <div className="cd-field">
            <span>Screenshots (optional)</span>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              hidden
              onChange={(e) => {
                addFiles(e.target.files);
                if (fileInput.current) fileInput.current.value = "";
              }}
            />
            <div>
              <Btn small onClick={() => fileInput.current?.click()}>
                Add images
              </Btn>
            </div>
            {files.length > 0 && (
              <div className="cd-bug-thumbs">
                {files.map((f, i) => (
                  <div key={`${f.name}-${i}`} className="cd-bug-thumb">
                    <img src={window.URL.createObjectURL(f)} alt={f.name} />
                    <button type="button" aria-label={`Remove ${f.name}`} onClick={() => removeFile(i)}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          {error && <div className="cd-chat-error">{error}</div>}
        </div>
        <div className="cd-bug-foot">
          <Btn onClick={() => !sending && setOpen(false)}>Cancel</Btn>
          <Btn kind="primary" disabled={!description.trim() || !email.trim() || sending} onClick={submit}>
            {sending ? "Sending…" : "Send report"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Mount it in `app/components/dashboard/DashboardApp.tsx`**

Add the import next to the `AssistantPanel` import:

```tsx
import BugReportButton from "./BugReportButton";
```

Mount it right beside `<AssistantPanel app={app} />`:

```tsx
      <AssistantPanel app={app} />
      <BugReportButton app={app} />

      <ToastHost toasts={toasts} />
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck`
Expected: exit 0. (If `CDIcon name="warn"` is rejected by the icon-name union, swap to an existing name such as `"assist"` — verify against `app/components/dashboard/icons.tsx`.)
Run: `npm run build`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/components/dashboard/BugReportButton.tsx app/styles/dashboard.css app/components/dashboard/DashboardApp.tsx
git commit -m "components/dashboard: report-a-bug launcher + modal, mount beside assistant" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Env docs + full pre-commit gate + manual verification

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Document the optional env var**

In `.env.example`, after the `DIGEST_*` block, add:

```
# === Bug reports (Report a bug launcher) ===
# Recipients for merchant-submitted bug reports, comma-separated. Optional: if
# unset, reports go to DIGEST_TO + DIGEST_CC (already the team). Reuses
# RESEND_API_KEY + DIGEST_FROM to send; screenshots are stored in the private
# Supabase Storage bucket `bug-reports`.
BUG_REPORT_TO=
```

- [ ] **Step 2: Run the full pre-commit gate (CLAUDE.md)**

Run each and confirm green, in order:
- `/code-review` — resolve every blocker.
- `git diff --check` — no whitespace errors; confirm no stray `console.log`/`.only`/`TODO(me)` introduced.
- `npm run typecheck` → exit 0.
- `npm run lint` → exit 0 (no warnings on touched files).
- `npm run build` → exit 0.
- `npm run test` → all pass.
- `npx prisma validate` is **not required** (no `prisma/schema.prisma` change; the bug_report table is Supabase-managed, applied in Task 4).

- [ ] **Step 3: Commit the env docs**

```bash
git add .env.example
git commit -m "env: document optional BUG_REPORT_TO (falls back to DIGEST recipients)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Manual verification (real app)**

Embedded app:
1. Launch the app; confirm a **Report a bug** button sits just above **Ask Calderyn** (bottom-right) and doesn't overlap it.
2. Open it; submit with description + email, no screenshot → success toast; modal closes.
3. Confirm an email arrives at the team addresses, **reply-to is the merchant email**, and a `bug_report` row exists (`mcp__supabase__execute_sql`: `select email_status, surface, attachments from bug_report order by created_at desc limit 1;`) with `email_status = 'sent'`, `surface = 'app'`.
4. Submit again with 1–2 screenshots → confirm they arrive attached to the email and an object exists under the `bug-reports` bucket (path `…/<reportId>/0-…`).
5. Edge cases: empty description / bad email → inline error, no send. A `.svg`, a >5 MB image, and a 4th image are each rejected with the right message.

Dashboard:
6. Repeat 1–5 on the dashboard surface; confirm `surface = 'dashboard'` rows and the launcher sits above the dashboard's Ask Calderyn launcher.

- [ ] **Step 5: Finish the branch**

Use superpowers:finishing-a-development-branch to choose merge/PR. Do not push or open a PR until the gate in Step 2 is fully green and manual verification passed.

---

## Self-Review (completed during planning)

**Spec coverage:**
- Launcher above Ask Calderyn, both surfaces → Tasks 6, 8.
- Form: description + email + ≤3 screenshots (5 MB, raster-only, no SVG) → Tasks 2 (limits), 6/8 (UI).
- Auto-captured context (shop, surface, screen, user-agent, timestamp) → Task 3 (`parseBugReportForm` + `emailText`).
- Email to the 3 via Resend, reply-to merchant, attachments inline → Tasks 1, 3.
- Durable copy: `bug_report` row + private `bug-reports` bucket → Tasks 3, 4.
- Recipients via `BUG_REPORT_TO` with `DIGEST_TO`+`DIGEST_CC` fallback → Task 3 (`recipients()`), Task 9 (docs).
- Graceful degradation (storage fail / email fail / not configured) → Task 3 + tests.
- RLS deny-all, service-role only → Task 4.
- Tests on the shared brain → Tasks 1–3.
- Dashboard parity (no single-sided ship) → both surfaces in this plan.

**Type/name consistency:** `validateBugReportInput`, `parseBugReportForm`, `submitBugReport`, `sendEmail`, `BUG_REPORT_BUCKET`; types `AttachmentMeta`/`ParsedAttachment`/`BugReportInput`/`BugReportContext`/`ValidationResult`/`SubmitResult`/`EmailAttachment`/`DeliveryResult` — used consistently across tasks. Routes import `parseBugReportForm`+`submitBugReport`; submit.server imports `sendEmail`+`validateBugReportInput`.

**Known verify-at-runtime points (flagged in steps):** Polaris `Modal` + `useAppBridge().toast.show` render standalone in the embedded shell (Task 6); `CDIcon name="warn"` exists in the dashboard icon set (Task 8, with fallback noted).
