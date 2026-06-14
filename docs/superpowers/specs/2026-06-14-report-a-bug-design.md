# Report a Bug — Design Spec

**Date:** 2026-06-14
**Status:** Approved (design), pending implementation plan
**Surfaces:** Embedded Shopify app (`/app/*`, Polaris) **and** Calderyn dashboard (`/dashboard/*`, custom CSS)

## Overview

A lightweight "Report a bug" control that lets a merchant describe a problem, leave an
email for follow-up, and optionally attach screenshots. Reports are emailed to the team
(reply-to set to the merchant) and saved durably in Supabase. The control sits in the
bottom-right corner, stacked **above** the existing "Ask Calderyn" launcher, on both
surfaces.

This mirrors the existing assistant architecture: one shared server "brain" with two
native front-ends (Polaris on the embedded app, custom CSS on the dashboard).

## Goals

- One- or two-field report (description + email) plus optional screenshots, submittable in seconds.
- Reports reach the team by email **and** are stored so none are lost.
- Auto-attach diagnostic context so bugs are reproducible without back-and-forth.
- Identical behavior and data contract on both surfaces (dashboard parity rule).

## Non-goals (YAGNI)

- No severity/category selector. Description + email only.
- No video or PDF uploads; raster images only.
- No in-image annotation/markup tools.
- No paste-from-clipboard in v1 (easy future add).
- No in-app "my reports" list, no Slack/ticketing integration.

## Architecture

```
   Embedded app  ┌──────────────────────────────┐
   (/app/*)      │  BugReportButton (Polaris)   │  app/components/BugReport/
   Polaris UI    │  modal: desc + email + files │  mounted in app/routes/app.tsx
                 └───────────────┬──────────────┘
                                 │ POST multipart FormData
                                 ▼
                    app/routes/app.bug-report.tsx  (action)
                                 │
                                 ▼
        ┌──────────────────────────────────────────────┐
        │  app/lib/bug-report/submit.server.ts          │ ← shared brain
        │  validate → upload images → save row → email  │
        └──────┬─────────────┬──────────────┬───────────┘
               │             │              │
        Supabase Storage  Supabase        app/lib/email/send.server.ts
        bucket            `bug_report`    (Resend; reply_to = merchant;
        `bug-reports`     table            image attachments)
                                 ▲
                                 │ POST multipart FormData
   Dashboard      ┌─────────────┴────────────────┐
   (/dashboard/*) │ BugReportButton (custom CSS) │  app/components/dashboard/
   custom UI      │  panel: desc + email + files │  mounted in DashboardApp.tsx
                 └──────────────────────────────┘
                    app/routes/dashboard.api.bug-report.tsx  (action)
```

Each route is responsible only for **auth + parsing its transport** into a normalized
input, then calling the shared `submitBugReport()`. The shared function is
transport-agnostic and surface-agnostic.

Both surfaces are behind a session (Shopify admin session / dashboard session cookie), so
only authenticated merchants can submit — no captcha needed.

## UI & placement

The button stacks above the Ask Calderyn launcher, bottom-right, on both surfaces, using
quieter/secondary styling so it does not compete with the primary accent launcher.

- Embedded app launcher today: `position: fixed; right: 20px; bottom: 20px; z-index: 519`.
  Bug button sits above it (same right edge, larger `bottom`, same `z-index`).
- Dashboard launcher today: `.cd-chat-launcher` at `right: 20px; bottom: 84px; z-index: 60`.
  Bug button sits above it (same right edge, larger `bottom`, same `z-index`).

Exact offsets resolved during implementation from the real launcher heights.

Clicking opens a small modal (embedded) / panel (dashboard), identical shape on both:

```
   ┌──────────────────────────────────┐
   │  Report a bug                 ✕  │
   │  What went wrong?                │
   │  ┌──────────────────────────────┐│
   │  │ (textarea, required)         ││
   │  └──────────────────────────────┘│
   │  Your email (so we can reply)    │
   │  ┌──────────────────────────────┐│
   │  │ you@store.com (required)     ││
   │  └──────────────────────────────┘│
   │  Screenshots (optional)          │
   │  ┌──────────────────────────────┐│
   │  │   ⬆ Drag images or browse    ││
   │  └──────────────────────────────┘│
   │   [img] ✕   [img] ✕              │  ← thumbnails, removable
   │                  [ Send report ] │
   └──────────────────────────────────┘
```

- Embedded: Polaris `Modal` + `TextField` (description multiline, email) + `DropZone`
  with `DropZone.FileUpload` and image thumbnails. Submit via `useFetcher`. Success →
  close + App Bridge toast; failure → keep typed text and show inline error.
- Dashboard: custom panel matching `.cd-*` design tokens; `<textarea>` + email `<input>`
  + styled file input with drag-drop and thumbnail previews (✕ to remove). Success →
  close + `ToastHost` toast; failure → keep typed text and show inline error.
- Email field is prefilled from session if a merchant email is readily available;
  otherwise blank. Always editable.

## Input contract (normalized, passed to `submitBugReport`)

```
{
  shopDomain: string,            // from authenticated session
  reporterEmail: string,         // validated
  description: string,           // validated, trimmed
  surface: 'app' | 'dashboard',
  context: {
    screen: string,              // route/path or active dashboard screen
    userAgent: string,
    submittedAt: string,         // ISO timestamp (server-stamped)
  },
  attachments: Array<{
    filename: string,
    contentType: string,
    bytes: Uint8Array,
  }>,
}
```

## Email

Reuses the existing Resend integration. The generic sender currently in
`app/lib/github-digest/deliver.server.ts` is **extracted** to
`app/lib/email/send.server.ts` and extended with:

- `replyTo` — set to the merchant's email so the team can reply directly.
- `attachments` — `Array<{ filename, content /* base64 */, contentType? }>`.

`github-digest` updates its import to the new location (no behavior change there).

- **To:** `BUG_REPORT_TO` (new env; default `keyuchen@calderyncompany.com,
  john@calderyncompany.com, kennethlee@calderyncompany.com`).
- **From:** reuse `DIGEST_FROM` (verified Resend sender).
- **API key:** reuse `RESEND_API_KEY`.
- **Subject:** e.g. `🐞 Bug report from {shopDomain}`.
- **Body:** description + context (shop, surface, screen, user-agent, timestamp).
- **Attachments:** screenshots inline so the team sees them in their inbox.

## Storage (screenshots)

- Private Supabase Storage bucket `bug-reports` (not public).
- Object path: `bug-reports/{shopDomain}/{reportId}/{index}-{safeFilename}`.
- Recorded in the DB row's `attachments` column.
- Viewing is via the Supabase dashboard or short-lived signed URLs (team-only); images are
  never rendered back into any app HTML (avoids stored-XSS).

## Database

New Supabase table `bug_report` (RLS **on**, service-role access only — matches the
existing security hardening; no anon/public policy):

| column          | type          | notes                                            |
|-----------------|---------------|--------------------------------------------------|
| id              | uuid pk       | default `gen_random_uuid()`                      |
| created_at      | timestamptz   | default `now()`                                  |
| shop_domain     | text          | from session                                     |
| reporter_email  | text          | what the merchant typed                          |
| description     | text          | what the merchant typed                          |
| surface         | text          | `app` or `dashboard`                             |
| context         | jsonb         | `{ screen, userAgent, submittedAt }`             |
| attachments     | jsonb         | `[{ path, filename, content_type, size_bytes }]`, default `[]` |
| email_status    | text          | `sent` or `failed`                               |
| email_error     | text null     | error detail when `failed`                       |

Created via a Supabase migration (raw SQL, dashboard-side convention). Bucket created
alongside.

## Validation & security (server-side; never trust the client)

- `description`: required, trimmed, non-empty, max ~5,000 chars.
- `reporterEmail`: required, basic email-format check, max ~320 chars.
- Attachments: at most **3** files, each ≤ **5 MB**, content-type **and** extension both in
  allowlist `{ png, jpg/jpeg, gif, webp }`. **SVG explicitly rejected** (script-carrying).
- Reject malformed input with `422` and a clear message; client mirrors these checks for UX
  but the server is authoritative.
- Dashboard route enforces same-origin (existing `requireSameOrigin` helper).
- Optional lightweight idempotency key (client-generated per modal open) to dedupe
  double-submits, consistent with existing action patterns.

## Reliability / graceful degradation

Order inside `submitBugReport`: validate → upload images to Storage → insert row → send
email.

- **Storage upload fails:** log it, continue with the bytes already in memory — email still
  sends with the attachment; row saved with whatever uploaded (or empty `attachments`).
  Net effect ≈ email-attachment-only. Merchant is not blocked.
- **Email fails:** row is still saved with `email_status='failed'` and `email_error`, so the
  report is never lost. Merchant still sees success (they did their part).
- **Resend not configured (no key/sender):** treated as an email failure — row saved,
  `email_status='failed'`. Surfaced as a launch dependency (set `RESEND_API_KEY` /
  `DIGEST_FROM` / `BUG_REPORT_TO` in the Vercel `shopify-app` env).

## Files

**New**
- `app/lib/bug-report/submit.server.ts` — shared brain (validate, upload, persist, email).
- `app/lib/email/send.server.ts` — generic Resend sender (extracted from github-digest;
  adds `replyTo` + `attachments`).
- `app/routes/app.bug-report.tsx` — embedded resource route (multipart FormData action).
- `app/routes/dashboard.api.bug-report.tsx` — dashboard API route (multipart FormData action).
- `app/components/BugReport/BugReportButton.tsx` — Polaris launcher + modal.
- `app/components/dashboard/BugReportButton.tsx` — custom-CSS launcher + panel.
- One Supabase migration — `bug_report` table + RLS; `bug-reports` storage bucket.

**Edit**
- `app/routes/app.tsx` — mount `BugReportButton` near the assistant.
- `app/components/dashboard/DashboardApp.tsx` — mount dashboard `BugReportButton`.
- `app/lib/github-digest/deliver.server.ts` — import generic sender from new location.
- `.env.example` — add `BUG_REPORT_TO`; note `RESEND_API_KEY` / `DIGEST_FROM` reuse.
- Dashboard CSS — styles for the new launcher/panel (`app/styles/dashboard.css`).

## Configuration / env

| var               | status | purpose                                                   |
|-------------------|--------|-----------------------------------------------------------|
| `RESEND_API_KEY`  | reuse  | Resend API auth                                           |
| `DIGEST_FROM`     | reuse  | verified Resend sender ("from")                           |
| `BUG_REPORT_TO`   | new    | comma-separated recipients (defaults to the 3 teammates)  |

## Testing

Unit tests on `submit.server.ts` (Vitest, matching repo conventions):

- Rejects empty description and invalid/missing email (`422`).
- Rejects >3 files, oversized files, and disallowed types (incl. SVG).
- Happy path: uploads attachments, inserts row, calls email sender with `replyTo` +
  base64 attachments, returns success.
- Email-failure path: still inserts row with `email_status='failed'`.
- Storage-failure path: still sends email and inserts row.

Plus the standard pre-commit gate: `/code-review`, typecheck, lint, build, `prisma validate`
(no Prisma schema change expected), and the Supabase migration applied/validated.

## Open questions

None. Defaults locked: 3 screenshots × 5 MB, raster-only, Supabase Storage bucket +
email attachments, both surfaces.
