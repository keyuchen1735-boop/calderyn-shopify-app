# Pilot onboarding invite — send engine

**Date:** 2026-06-15
**Branch / worktree:** `feat/pilot-invite` → `../calderyn-pilot-invite`
**Status:** Approved design, pre-plan.

## 1. Goal

The Calderyn founders are inviting selected waitlist signups into the free beta
pilot. A teammate is building an internal admin panel at
`calderyncompany.com/panel` that lists waitlist signups, each with a **Send
invite** button. This spec covers **only the send engine** that the panel's
button calls — not the panel UI itself.

The engine, living in this repo (`app.calderyn­company.com`, Vercel project
`shopify-app`):

1. Renders the pilot onboarding **email** (from the handoff `calderyn-pilot-email.html`),
   personalized per recipient, and sends it via Resend.
2. Hosts the **"view in browser"** version of that email (from the handoff
   `calderyn-pilot-web.html`) as a public personalized page.
3. Hosts the two brand-mark logos the email references (Gmail strips local/data-URI
   images, so they need absolute https URLs).
4. Records every send in a Supabase `pilot_invites` table and honors an
   `email_optouts` suppression list, with a working RFC 8058 unsubscribe.

Design references (source of truth for pixels/copy/tokens): the two HTML files and
token table in `~/Downloads/handoff/CLAUDE_CODE_PROMPT.md`.

## 2. Scope

**In scope (this repo, this task):**
- `app/lib/pilot-invite/` rendering + validation + suppression + invite-log libs.
- Routes: `pilot._index` (view-in-browser), `pilot.api.send-invite` (POST),
  `pilot.api.preview` (GET), `pilot.unsubscribe` (GET/POST), two logo resource routes.
- Two Supabase tables (`pilot_invites`, `email_optouts`) + their migrations.
- A backward-compatible `headers` param on the shared `sendEmail()`.
- Env additions + `.env.example`.

**Out of scope (teammate / other tasks):**
- The `/panel` admin UI (list + button) — the teammate builds it and calls our contract.
- The marketing-site (`Mezoh/calderyn-waitlist`) `vercel.json` proxy rule for `/panel/*`.
  Not needed for *sending*: the panel calls our endpoint server-to-server at the app origin.
- The `https://calderyncompany.com/pilot-feedback` page (the email links to it; building it is separate).
- Bulk/scheduled sending, per-recipient rate limiting (one-at-a-time, internal, behind a secret).

**Dashboard-parity note:** this is an **internal founder tool**, not a merchant-facing
feature, so the mandatory dashboard-parity mirror does **not** apply (parity is for
merchant-facing behavior; internal tooling is exempt).

## 3. The two formats (resolving the "web + mobile" framing)

The handoff has two files. They are **two renderings of one onboarding email**:

| File | What it is | Where it lives | Personalized |
|---|---|---|---|
| `calderyn-pilot-email.html` | The **delivered email** — table layout, inline styles, MSO/VML Outlook fallback, `@media` responsive (phone + desktop *mail clients*). | Rendered server-side, sent via Resend. | yes |
| `calderyn-pilot-web.html` | The **"view in browser"** twin — rich webpage (flexbox, sticky nav, `@keyframes`). Cannot be delivered as mail (clients strip it). | Hosted at `GET /pilot`. | yes (from query string) |

The delivered email gets a **"View in browser"** link at the top pointing at the
`/pilot` URL with the recipient's fields — this is the only structural addition to
the handoff email markup.

## 4. Architecture & file layout

```
app/lib/pilot-invite/
  content.ts            # shared copy/data/tokens + escapeHtml(); no server-only deps
  email.server.ts       # renderPilotEmail(opts) -> { subject, html, text }   (email file)
  landing.server.ts     # renderPilotLanding(opts) -> html string             (web file)
  marks.ts              # base64 PNG constants for the two logos (resized)
  validate.ts           # parseInviteInput(unknown) -> Result<InviteInput>
  unsubscribe.server.ts # signUnsubToken / verifyUnsubToken (jose HS256); recordOptOut / isOptedOut
  invites.server.ts     # logInvite(row); hasSuccessfulInvite(email)  (Supabase pilot_invites)
  __tests__/            # render, validate, token, suppression, auth

app/lib/email/send.server.ts   # + optional `headers?: Record<string,string>` (backward compatible)

app/routes/
  pilot._index.tsx              # GET  /pilot                  view-in-browser (public)
  pilot.api.send-invite.tsx     # POST /pilot/api/send-invite  bearer-protected
  pilot.api.preview.tsx         # GET  /pilot/api/preview      email HTML for iframe (public)
  pilot.unsubscribe.tsx         # GET  confirm/done + POST one-click (public, tokened)
  [pilot-mark-teal.png].tsx     # GET  logo (base64, favicon pattern)
  [pilot-mark-white.png].tsx    # GET  logo

supabase/migrations/
  <ts>_pilot_invites.sql
  <ts>_email_optouts.sql
```

`*.server.ts` = server-only (never imported by a client module). `content.ts` and
`validate.ts` are pure (no env, no I/O) so they're unit-testable in isolation and
shared by both renderers.

## 5. Data contract (what the teammate's panel codes against)

### 5.1 Send an invite
```
POST {APP_ORIGIN}/pilot/api/send-invite
Authorization: Bearer {PILOT_INVITE_SECRET}
Content-Type: application/json

{ "email": "jane@store.com", "first_name": "Jane", "store_name": "Jane's Goods",
  "skip_if_invited": false }      // skip_if_invited optional, default false
```
Responses (always JSON; HTTP status mirrors outcome):

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ "sent": true, "id": "<resend-id>" }` | Delivered + logged `status:'sent'`. |
| 200 | `{ "sent": false, "alreadyInvited": true }` | `skip_if_invited` set and a prior `sent` row exists; nothing sent. |
| 400 | `{ "sent": false, "error": "<field>: <reason>" }` | Validation failed. |
| 401 | `{ "sent": false, "error": "unauthorized" }` | Missing/wrong bearer. |
| 409 | `{ "sent": false, "error": "recipient unsubscribed" }` | Email is on the suppression list. |
| 502 | `{ "sent": false, "error": "<resend detail>" }` | Resend rejected; logged `status:'failed'`. |

Must be called **server-to-server** from the panel's backend — the secret cannot
ship to a browser. `GET`/other methods → 405.

### 5.2 Preview the email
```
GET {APP_ORIGIN}/pilot/api/preview?first_name=Jane&store_name=Jane%27s%20Goods
→ 200 text/html   (the exact email HTML, escaped inputs, no data access)
```
Public, safe for an `<iframe>`. Same trust level as `/pilot`. Missing params render
sensible fallbacks (`first_name` → "there", `store_name` → "your store").

### 5.3 View in browser (the web twin)
```
GET {APP_ORIGIN}/pilot?first_name=Jane&store_name=Jane%27s%20Goods
→ 200 text/html   (web landing, escaped inputs)
```

### 5.4 Unsubscribe
```
GET  {APP_ORIGIN}/pilot/unsubscribe?token=<jwt>   → confirm page (then done page)
POST {APP_ORIGIN}/pilot/unsubscribe?token=<jwt>   → one-click (RFC 8058); records opt-out, 200
```
Invalid/missing token → 400 with a neutral message (no email disclosure).

### 5.5 Reading status (no endpoint needed)
The panel reads the `pilot_invites` and `email_optouts` tables **directly** from
Supabase with the service-role client (exactly how the digest reads `waitlist`), to
render "invited ✓ / failed / unsubscribed" state. We expose no extra read endpoint.

## 6. Personalization & escaping

- `InviteInput` (internal, camelCase): `{ email: string; firstName: string; storeName: string; skipIfInvited?: boolean }`.
  API JSON uses snake_case (`first_name`, `store_name`) to match `waitlist`/merge-tag naming; `parseInviteInput` maps + validates.
- `first_name` / `store_name` are **operator-entered** (the `waitlist` table stores
  neither). The panel collects them per send; the engine treats them as untrusted text.
- Every interpolation into HTML (email, preview, landing) goes through `escapeHtml()`.
  The `/pilot` and `/pilot/api/preview` routes reflect query params into markup, so
  escaping is a genuine **stored/reflected-XSS guard**, not cosmetic. Email subject is
  plaintext (no HTML escaping; trimmed only).
- Placeholders to replace in both templates: `{{first_name}}`, `{{store_name}}`.
  Fallbacks when blank: `first_name` → "there"; `store_name` → "your store".
- Fixed links (not personalized): install CTA `https://apps.shopify.com/calderynextension`;
  feedback `https://calderyncompany.com/pilot-feedback`.

## 7. Auth & security

- **Send endpoint:** constant-time bearer check. Add a generic
  `isAuthorizedBearer(authHeader, secret)` (the exact body of `isAuthorizedCron`:
  fail closed if secret unset, `timingSafeEqual` over equal-length buffers) in a shared
  util, and call it with `PILOT_INVITE_SECRET`. Leave `isAuthorizedCron` untouched to
  avoid churn on its callers (it may delegate to `isAuthorizedBearer` later, out of scope here).
- **Unsubscribe token:** `jose` `SignJWT`/`jwtVerify`, HS256 (same library/pattern as
  `mcp_oauth.server.ts`), secret `PILOT_UNSUB_SECRET`. Payload `{ sub: <lowercased email>, purpose: "pilot-unsub" }`,
  no expiry (links must work indefinitely). Verify checks signature + `purpose`.
- **Preview / landing:** public by design; only reflect escaped inputs, touch no data.
- **Supabase tables:** enable RLS with **no public policies** (server-side service-role
  client bypasses RLS; anon/auth roles get nothing).
- **PII:** recipient email/first/store are written to `pilot_invites` and the email body
  only. They are never sent to any AI model. Suppression list stores email only.

## 8. Asset hosting (logos)

- Two resource routes mirror `[favicon.png].tsx` / `app/lib/favicon.server.ts`: each
  returns `new Response(<bytes>, { headers: { "Content-Type": "image/png",
  "Cache-Control": "public, max-age=31536000, immutable" } })`.
- Source PNGs (`calderyn-mark-teal.png` 100 KB, `calderyn-mark-white.png` 49 KB) render
  at 22–48 px. **Resize to ~96 px** (2× of the largest use) before base64-embedding in
  `marks.ts`, to keep the source file and email weight sane. (`sips` is fine for the resize.)
- Absolute URL helper: `appOrigin(request) = process.env.PUBLIC_APP_URL ?? process.env.SHOPIFY_APP_URL ?? new URL(request.url).origin`.
  Renderers receive `baseUrl` and build `${baseUrl}/pilot-mark-teal.png`, etc. Email images **must** be absolute https.

## 9. Supabase schema (co-located with `waitlist`, NOT Prisma/SQLite)

Prisma/SQLite in this repo is **only** Shopify session storage (ephemeral, per-deploy,
not shared with the panel). The pilot data lives in the shared Supabase project next to
`waitlist`, so both this app and the teammate's panel read it with the service-role client.
Created via Supabase migrations (not `prisma migrate`).

```sql
-- <ts>_pilot_invites.sql
create table if not exists public.pilot_invites (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  first_name  text not null,
  store_name  text not null,
  status      text not null check (status in ('sent','failed')),
  resend_id   text,
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists pilot_invites_email_idx      on public.pilot_invites (lower(email));
create index if not exists pilot_invites_created_at_idx  on public.pilot_invites (created_at desc);
alter table public.pilot_invites enable row level security;  -- no policies: service-role only

-- <ts>_email_optouts.sql
create table if not exists public.email_optouts (
  email       text primary key,        -- stored lowercased
  reason      text,
  source      text not null default 'pilot',
  created_at  timestamptz not null default now()
);
alter table public.email_optouts enable row level security;  -- no policies: service-role only
```

## 10. Shared `sendEmail()` change

Add one optional, backward-compatible field:
```ts
export async function sendEmail(opts: {
  /* …existing… */
  headers?: Record<string, string>;
}): Promise<DeliveryResult>
```
When present, include `headers` in the Resend payload. Used to set:
```
List-Unsubscribe: <{APP_ORIGIN}/pilot/unsubscribe?token=…>, <mailto:unsubscribe@calderyncompany.com?subject=unsubscribe>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```
No existing caller passes `headers`, so behavior is unchanged for digest/bug-report. Covered by a new test.

## 11. Send flow (endpoint action)

1. Method `POST`? else 405.
2. Bearer authorized? else 401.
3. `parseInviteInput(json)` → 400 on failure.
4. `isOptedOut(email)` → 409 if suppressed.
5. If `skipIfInvited` and `hasSuccessfulInvite(email)` → 200 `{sent:false, alreadyInvited:true}`.
6. `renderPilotEmail({ firstName, storeName, baseUrl })` → `{subject, html, text}`.
7. `sendEmail({ apiKey: RESEND_API_KEY, from: PILOT_FROM, to: email, subject, html, text, headers: { …List-Unsubscribe… } })`.
8. `logInvite({ email, firstName, storeName, status, resendId, error })` (best-effort; a
   log-write failure is surfaced in the response note, never masks a real send result — rule 12).
9. Return 200 on `sent`, 502 on Resend failure.

## 12. Error handling (rule 12 — fail visibly)

- `sendEmail` already never throws and returns `{sent,error}`; the endpoint surfaces the
  exact Resend error string (truncated) — never a generic "failed".
- Supabase read/write failures (suppression check, invite log) are caught and surfaced:
  a suppression-check failure **fails closed** (does not send; returns 502 with the error)
  so we never email someone we couldn't verify; an invite-log failure after a successful
  send returns `{sent:true, id, logWarning:"<error>"}` (the send is real; the log gap is reported).
- Missing env (`RESEND_API_KEY`, `PILOT_FROM`, `PILOT_INVITE_SECRET`, `PILOT_UNSUB_SECRET`)
  → explicit 500/401 with which key is missing (server logs), never a silent no-op.

## 13. Environment variables (add to `.env.example`)

| Var | Purpose | Notes |
|---|---|---|
| `RESEND_API_KEY` | Resend auth | already exists |
| `PILOT_FROM` | From address | e.g. `Calderyn <onboarding@calderyncompany.com>`; domain must be Resend-verified |
| `PILOT_INVITE_SECRET` | Bearer for the send endpoint | shared with the panel backend |
| `PILOT_UNSUB_SECRET` | HMAC key for unsubscribe tokens | |
| `PUBLIC_APP_URL` | Canonical app origin for absolute URLs | optional; falls back to `SHOPIFY_APP_URL` then request origin |

## 14. Testing (behavior, not coverage theater — rule 9)

- `validate.ts`: rejects bad email, blank/over-long name/store, non-object body; maps snake→camel; trims.
- `content.ts` `escapeHtml`: neutralizes `<`, `>`, `&`, `"`, `'`; a `<script>` in `store_name` is inert in rendered HTML.
- `email.server.ts`: no `{{…}}` placeholders remain; logo `src` are absolute https; install CTA intact; subject personalized; plaintext `text` present and non-empty.
- `landing.server.ts`: placeholders replaced; params escaped.
- `unsubscribe.server.ts`: sign→verify round-trips; wrong-purpose / tampered token rejected.
- auth helper: missing / wrong / right bearer → false/false/true.
- `sendEmail` headers: payload includes `headers` only when provided; existing callers unaffected.

## 15. Pre-commit gate (CLAUDE.md, before any commit/PR)

`/code-review` clean → `git diff --check` → `npm run typecheck` → `npm run lint`
(`--max-warnings=0` on new files) → `npm run build`. No `npx prisma migrate diff` (no
Prisma schema change). Supabase migrations applied/validated against the project. Paste
results; never assert green without evidence.

## 16. Open assumptions (correct me if wrong)

1. `PILOT_FROM` uses a Resend-verified `calderyncompany.com` sender; if the domain isn't
   verified in Resend yet, sends fail-closed with a surfaced error (that's a config task, not code).
2. The teammate's panel calls the send endpoint **server-side** and holds `PILOT_INVITE_SECRET`.
3. One invite per click; no batch endpoint.
4. `unsubscribe@calderyncompany.com` (mailto fallback) is monitored or aliased — otherwise drop the mailto and keep only the https one-click.
