# Pilot Invite Send-Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-side engine that renders a personalized pilot-onboarding email, sends it via Resend, hosts its "view in browser" twin + logos, and records sends/opt-outs in Supabase — exposed as a bearer-protected endpoint the teammate's `/panel` button calls.

**Architecture:** A pure `app/lib/pilot-invite/` library (escape/validate/render/token/Supabase access) behind thin Remix resource routes (loaders/actions returning `Response`, no React). New data (`pilot_invites`, `email_optouts`) lives in the shared Supabase project next to `waitlist`, not Prisma/SQLite. The shared `sendEmail()` gets a backward-compatible `headers` param for `List-Unsubscribe`.

**Tech Stack:** Remix (`@remix-run/node`, fs-routes), TypeScript strict, Resend (existing `sendEmail`), Supabase (`@supabase/supabase-js`, existing `getSupabase`), `jose@5` (HS256 unsub token), vitest.

**Spec:** `docs/superpowers/specs/2026-06-15-pilot-invite-send-engine-design.md`

**Conventions:** ES modules; `~/...` path alias; server-only files end `.server.ts`; explicit return types; no `any`. Tests co-located in `__tests__/`, run with `npm test`. Commit after every green task.

---

## File Structure

| File | Responsibility |
|---|---|
| `docs/superpowers/specs/handoff-pilot/` | Vendored design references (email + web HTML, 2 PNGs) |
| `app/lib/pilot-invite/content.ts` | `escapeHtml`, fixed URLs, fallbacks, `markUrls`/`viewInBrowserUrl` helpers (pure) |
| `app/lib/pilot-invite/validate.ts` | `parseInviteInput(unknown)` → `InviteInput` (pure) |
| `app/lib/pilot-invite/origin.server.ts` | `appOrigin(request)` absolute base URL |
| `app/lib/cron-auth.server.ts` | + `isAuthorizedBearer` (generic constant-time bearer) |
| `app/lib/pilot-invite/marks.ts` | base64 logo bytes → `pilotMark{Teal,White}Response()` |
| `app/routes/[pilot-mark-teal.png].tsx` / `[pilot-mark-white.png].tsx` | logo resource routes |
| `app/lib/email/send.server.ts` | + optional `headers` param |
| `app/lib/pilot-invite/unsubscribe.server.ts` | sign/verify unsub token; `recordOptOut`/`isOptedOut` |
| `app/lib/pilot-invite/invites.server.ts` | `logInvite`/`hasSuccessfulInvite` |
| `supabase/migrations/*_pilot_invites.sql` / `*_email_optouts.sql` | new tables |
| `app/lib/pilot-invite/email.server.ts` | `renderPilotEmail` → `{subject,html,text}` |
| `app/lib/pilot-invite/landing.server.ts` | `renderPilotLanding` → html |
| `app/routes/pilot._index.tsx` | `GET /pilot` view-in-browser |
| `app/routes/pilot.api.preview.tsx` | `GET /pilot/api/preview` email HTML |
| `app/routes/pilot.unsubscribe.tsx` | `GET`/`POST /pilot/unsubscribe` |
| `app/routes/pilot.api.send-invite.tsx` | `POST /pilot/api/send-invite` (orchestrates all) |
| `.env.example` | new env keys |

---

### Task 1: Vendor the design references into the repo

**Files:** Create `docs/superpowers/specs/handoff-pilot/{calderyn-pilot-email.html,calderyn-pilot-web.html,calderyn-mark-teal.png,calderyn-mark-white.png}`

- [ ] **Step 1: Copy the handoff files in**

```bash
mkdir -p docs/superpowers/specs/handoff-pilot
cp ~/Downloads/handoff/calderyn-pilot-email.html docs/superpowers/specs/handoff-pilot/
cp ~/Downloads/handoff/calderyn-pilot-web.html   docs/superpowers/specs/handoff-pilot/
cp ~/Downloads/handoff/assets/calderyn-mark-teal.png  docs/superpowers/specs/handoff-pilot/
cp ~/Downloads/handoff/assets/calderyn-mark-white.png docs/superpowers/specs/handoff-pilot/
ls -la docs/superpowers/specs/handoff-pilot/
```
Expected: 4 files listed (two .html, two .png).

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/handoff-pilot
git commit -m "docs/specs: vendor pilot onboarding design references"
```

---

### Task 2: `content.ts` — escaping, URLs, helpers

**Files:** Create `app/lib/pilot-invite/content.ts`; Test `app/lib/pilot-invite/__tests__/content.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { escapeHtml, markUrls, viewInBrowserUrl } from "../content";

describe("escapeHtml", () => {
  it("neutralizes HTML metacharacters", () => {
    expect(escapeHtml(`<script>alert("x")&'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;");
  });
});

describe("url helpers", () => {
  it("builds absolute mark URLs without double slashes", () => {
    expect(markUrls("https://app.x.com/")).toEqual({
      teal: "https://app.x.com/pilot-mark-teal.png",
      white: "https://app.x.com/pilot-mark-white.png",
    });
  });
  it("encodes view-in-browser params", () => {
    expect(viewInBrowserUrl("https://app.x.com", "Jane", "Jane's Goods")).toBe(
      "https://app.x.com/pilot?first_name=Jane&store_name=Jane%27s+Goods",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- content.test`
Expected: FAIL — cannot find module `../content`.

- [ ] **Step 3: Implement**

```ts
// app/lib/pilot-invite/content.ts
// Shared, side-effect-free helpers for the pilot-invite email + landing templates.
// Pure (no env, no I/O) so both renderers and the routes can import it freely.

export const INSTALL_URL = "https://apps.shopify.com/calderynextension";
export const FEEDBACK_URL = "https://calderyncompany.com/pilot-feedback";
export const DEFAULT_FIRST_NAME = "there";
export const DEFAULT_STORE_NAME = "your store";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/** Escape text for safe interpolation into HTML attribute/element context. */
export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function trimTrailingSlash(base: string): string {
  return base.replace(/\/+$/, "");
}

export function markUrls(baseUrl: string): { teal: string; white: string } {
  const b = trimTrailingSlash(baseUrl);
  return { teal: `${b}/pilot-mark-teal.png`, white: `${b}/pilot-mark-white.png` };
}

export function viewInBrowserUrl(baseUrl: string, firstName: string, storeName: string): string {
  const b = trimTrailingSlash(baseUrl);
  const q = new URLSearchParams({ first_name: firstName, store_name: storeName });
  return `${b}/pilot?${q.toString()}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- content.test`
Expected: PASS (4 assertions).

- [ ] **Step 5: Commit**

```bash
git add app/lib/pilot-invite/content.ts app/lib/pilot-invite/__tests__/content.test.ts
git commit -m "lib/pilot-invite: shared escapeHtml + URL helpers"
```

---

### Task 3: `validate.ts` — request-body validation

**Files:** Create `app/lib/pilot-invite/validate.ts`; Test `app/lib/pilot-invite/__tests__/validate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseInviteInput } from "../validate";

describe("parseInviteInput", () => {
  it("accepts a valid body and lowercases the email", () => {
    const r = parseInviteInput({ email: "Jane@Store.com", first_name: " Jane ", store_name: "Jane's Goods" });
    expect(r).toEqual({ ok: true, value: { email: "jane@store.com", firstName: "Jane", storeName: "Jane's Goods", skipIfInvited: false } });
  });
  it("rejects a non-object body", () => {
    expect(parseInviteInput("nope")).toEqual({ ok: false, error: "body: expected a JSON object" });
  });
  it("rejects a bad email", () => {
    expect(parseInviteInput({ email: "x", first_name: "A", store_name: "B" })).toEqual({ ok: false, error: "email: invalid" });
  });
  it("rejects a blank first_name", () => {
    expect(parseInviteInput({ email: "a@b.co", first_name: "  ", store_name: "B" }).ok).toBe(false);
  });
  it("passes through skip_if_invited only when strictly true", () => {
    const r = parseInviteInput({ email: "a@b.co", first_name: "A", store_name: "B", skip_if_invited: true });
    expect(r.ok && r.value.skipIfInvited).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- validate.test`
Expected: FAIL — cannot find module `../validate`.

- [ ] **Step 3: Implement**

```ts
// app/lib/pilot-invite/validate.ts
// Validates the send-invite request body at the action boundary (never trust input).
// API JSON is snake_case (matches `waitlist`/merge-tag naming); internal type is camelCase.

export interface InviteInput {
  email: string;       // lowercased
  firstName: string;
  storeName: string;
  skipIfInvited: boolean;
}

export type ParseResult = { ok: true; value: InviteInput } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseInviteInput(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body: expected a JSON object" };
  const b = body as Record<string, unknown>;

  const email = typeof b.email === "string" ? b.email.trim() : "";
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, error: "email: invalid" };

  const firstName = typeof b.first_name === "string" ? b.first_name.trim() : "";
  if (!firstName || firstName.length > 80) return { ok: false, error: "first_name: required, max 80 chars" };

  const storeName = typeof b.store_name === "string" ? b.store_name.trim() : "";
  if (!storeName || storeName.length > 120) return { ok: false, error: "store_name: required, max 120 chars" };

  return { ok: true, value: { email: email.toLowerCase(), firstName, storeName, skipIfInvited: b.skip_if_invited === true } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- validate.test`
Expected: PASS (5 assertions).

- [ ] **Step 5: Commit**

```bash
git add app/lib/pilot-invite/validate.ts app/lib/pilot-invite/__tests__/validate.test.ts
git commit -m "lib/pilot-invite: parseInviteInput body validation"
```

---

### Task 4: Generic bearer auth helper

**Files:** Modify `app/lib/cron-auth.server.ts`; Test `app/lib/__tests__/cron-auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { isAuthorizedBearer } from "../cron-auth.server";

describe("isAuthorizedBearer", () => {
  it("is false when the secret is unset (fail closed)", () => {
    expect(isAuthorizedBearer("Bearer x", undefined)).toBe(false);
  });
  it("is false on a missing or wrong header", () => {
    expect(isAuthorizedBearer(null, "s3cret")).toBe(false);
    expect(isAuthorizedBearer("Bearer nope", "s3cret")).toBe(false);
  });
  it("is true on an exact match", () => {
    expect(isAuthorizedBearer("Bearer s3cret", "s3cret")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- cron-auth.test`
Expected: FAIL — `isAuthorizedBearer` is not exported.

- [ ] **Step 3: Implement (append to the existing file; leave `isAuthorizedCron` untouched)**

```ts
// Generic constant-time bearer check, reused by internal endpoints (e.g. pilot invite).
// Same hardening as isAuthorizedCron: fail closed if secret unset, equal-length timingSafeEqual.
export function isAuthorizedBearer(authHeader: string | null, secret: string | undefined): boolean {
  if (!secret) return false;
  if (!authHeader) return false;
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // length itself isn't secret
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- cron-auth.test`
Expected: PASS (4 assertions).

- [ ] **Step 5: Commit**

```bash
git add app/lib/cron-auth.server.ts app/lib/__tests__/cron-auth.test.ts
git commit -m "lib/cron-auth: add generic isAuthorizedBearer"
```

---

### Task 5: `origin.server.ts` — absolute base URL

**Files:** Create `app/lib/pilot-invite/origin.server.ts`; Test `app/lib/pilot-invite/__tests__/origin.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { appOrigin } from "../origin.server";

const ORIG = { ...process.env };
afterEach(() => { process.env = { ...ORIG }; });

describe("appOrigin", () => {
  it("prefers PUBLIC_APP_URL, stripping a trailing slash", () => {
    process.env.PUBLIC_APP_URL = "https://app.calderyncompany.com/";
    expect(appOrigin(new Request("https://whatever.test/x"))).toBe("https://app.calderyncompany.com");
  });
  it("falls back to the request origin when no env is set", () => {
    delete process.env.PUBLIC_APP_URL; delete process.env.SHOPIFY_APP_URL;
    expect(appOrigin(new Request("https://req.example/pilot"))).toBe("https://req.example");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- origin.test`
Expected: FAIL — cannot find module `../origin.server`.

- [ ] **Step 3: Implement**

```ts
// app/lib/pilot-invite/origin.server.ts
// Absolute origin for building email-safe (absolute https) asset + link URLs.
export function appOrigin(request: Request): string {
  const base = process.env.PUBLIC_APP_URL ?? process.env.SHOPIFY_APP_URL ?? new URL(request.url).origin;
  return base.replace(/\/+$/, "");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- origin.test`
Expected: PASS (2 assertions).

- [ ] **Step 5: Commit**

```bash
git add app/lib/pilot-invite/origin.server.ts app/lib/pilot-invite/__tests__/origin.test.ts
git commit -m "lib/pilot-invite: appOrigin base-URL helper"
```

---

### Task 6: Logo assets + resource routes

**Files:** Create `app/lib/pilot-invite/marks.ts`, `app/routes/[pilot-mark-teal.png].tsx`, `app/routes/[pilot-mark-white.png].tsx`; Test `app/lib/pilot-invite/__tests__/marks.test.ts`

- [ ] **Step 1: Resize + base64-encode the two PNGs**

The source marks render at 22–48 px; resize to 96 px to keep `marks.ts` small and the email light, then base64-encode:
```bash
cd docs/superpowers/specs/handoff-pilot
sips -Z 96 calderyn-mark-teal.png  --out /tmp/teal96.png
sips -Z 96 calderyn-mark-white.png --out /tmp/white96.png
echo "TEAL:";  base64 -i /tmp/teal96.png  | tr -d '\n' | head -c 80; echo
echo "WHITE:"; base64 -i /tmp/white96.png | tr -d '\n' | head -c 80; echo
```
Capture the full base64 strings (re-run without `head` to get the complete value) for Step 3.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { pilotMarkTealResponse, pilotMarkWhiteResponse } from "../marks";

describe("logo responses", () => {
  it("serve PNG bytes with an immutable cache header", async () => {
    for (const res of [pilotMarkTealResponse(), pilotMarkWhiteResponse()]) {
      expect(res.headers.get("Content-Type")).toBe("image/png");
      expect(res.headers.get("Cache-Control")).toContain("immutable");
      const buf = new Uint8Array(await res.arrayBuffer());
      expect(buf.length).toBeGreaterThan(100);
      // PNG magic number
      expect(Array.from(buf.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }
  });
});
```

- [ ] **Step 3: Implement (paste the full base64 from Step 1)**

```ts
// app/lib/pilot-invite/marks.ts
// Brand marks for the pilot email, base64-embedded (this app has no public/ pipeline —
// same approach as app/lib/favicon.server.ts). Resized to 96px.
const TEAL_PNG_B64 = "<PASTE FULL BASE64 OF /tmp/teal96.png>";
const WHITE_PNG_B64 = "<PASTE FULL BASE64 OF /tmp/white96.png>";

function pngResponse(b64: string): Response {
  return new Response(Buffer.from(b64, "base64"), {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" },
  });
}

export const pilotMarkTealResponse = (): Response => pngResponse(TEAL_PNG_B64);
export const pilotMarkWhiteResponse = (): Response => pngResponse(WHITE_PNG_B64);
```
> The two `<PASTE …>` tokens MUST be replaced with the actual base64 captured in Step 1 — the test asserts the PNG magic number, so a placeholder fails.

```ts
// app/routes/[pilot-mark-teal.png].tsx
import { pilotMarkTealResponse } from "~/lib/pilot-invite/marks";
export const loader = () => pilotMarkTealResponse();
```

```ts
// app/routes/[pilot-mark-white.png].tsx
import { pilotMarkWhiteResponse } from "~/lib/pilot-invite/marks";
export const loader = () => pilotMarkWhiteResponse();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- marks.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/pilot-invite/marks.ts "app/routes/[pilot-mark-teal.png].tsx" "app/routes/[pilot-mark-white.png].tsx" app/lib/pilot-invite/__tests__/marks.test.ts
git commit -m "routes/pilot-mark: serve base64 brand marks for the email"
```

---

### Task 7: `sendEmail` — optional `headers`

**Files:** Modify `app/lib/email/send.server.ts`; Test `app/lib/email/__tests__/send.server.test.ts`

- [ ] **Step 1: Add the failing test (append inside the existing `describe`)**

```ts
it("includes custom headers only when provided", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ id: "e4" }), { status: 200 }));
  await sendEmail({ apiKey: "k", from: "f", to: "y@x.com", subject: "s", text: "t",
    headers: { "List-Unsubscribe": "<https://x/u>" } });
  const withHeaders = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
  expect(withHeaders.headers).toEqual({ "List-Unsubscribe": "<https://x/u>" });

  await sendEmail({ apiKey: "k", from: "f", to: "y@x.com", subject: "s", text: "t" });
  const noHeaders = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
  expect(noHeaders.headers).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- send.server.test`
Expected: FAIL — `headers` not in the payload.

- [ ] **Step 3: Implement**

In the `opts` type, add after `attachments?`:
```ts
  headers?: Record<string, string>;
```
In the payload builder, after the `attachments` block:
```ts
    if (opts.headers && Object.keys(opts.headers).length) payload.headers = opts.headers;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- send.server.test`
Expected: PASS (all existing + new).

- [ ] **Step 5: Commit**

```bash
git add app/lib/email/send.server.ts app/lib/email/__tests__/send.server.test.ts
git commit -m "lib/email: optional headers param for List-Unsubscribe"
```

---

### Task 8: `unsubscribe.server.ts` — token + opt-out store

**Files:** Create `app/lib/pilot-invite/unsubscribe.server.ts`; Test `app/lib/pilot-invite/__tests__/unsubscribe.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

beforeEach(() => { process.env.PILOT_UNSUB_SECRET = "unit-test-secret"; });

describe("unsub token", () => {
  it("round-trips the email", async () => {
    const { signUnsubToken, verifyUnsubToken } = await import("../unsubscribe.server");
    const token = await signUnsubToken("Jane@Store.com");
    expect(await verifyUnsubToken(token)).toBe("jane@store.com");
  });
  it("rejects a tampered token", async () => {
    const { signUnsubToken, verifyUnsubToken } = await import("../unsubscribe.server");
    const token = await signUnsubToken("a@b.co");
    expect(await verifyUnsubToken(token + "x")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- unsubscribe.test`
Expected: FAIL — cannot find module `../unsubscribe.server`.

- [ ] **Step 3: Implement**

```ts
// app/lib/pilot-invite/unsubscribe.server.ts
// HS256 unsub token (same jose pattern as mcp_oauth.server.ts) + Supabase suppression list.
// Every Supabase call degrades to a surfaced error and never throws (rule 12).
import { SignJWT, jwtVerify } from "jose";
import { getSupabase } from "~/lib/supabase.server";

function unsubKey(): Uint8Array {
  const secret = process.env.PILOT_UNSUB_SECRET;
  if (!secret) throw new Error("PILOT_UNSUB_SECRET is not set");
  return new TextEncoder().encode(secret);
}

export async function signUnsubToken(email: string): Promise<string> {
  return new SignJWT({ purpose: "pilot-unsub" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(email.toLowerCase())
    .setIssuedAt()
    .sign(unsubKey());
}

/** Returns the lowercased email if the token is valid + purpose-scoped, else null. */
export async function verifyUnsubToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, unsubKey(), { algorithms: ["HS256"] });
    if (payload.purpose !== "pilot-unsub" || typeof payload.sub !== "string") return null;
    return payload.sub;
  } catch {
    return null;
  }
}

export async function recordOptOut(email: string, reason?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await getSupabase()
      .from("email_optouts")
      .upsert({ email: email.toLowerCase(), reason: reason ?? null, source: "pilot" }, { onConflict: "email" });
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** optedOut=false with a set `error` means "could not verify" — callers must fail closed. */
export async function isOptedOut(email: string): Promise<{ optedOut: boolean; error?: string }> {
  try {
    const { data, error } = await getSupabase()
      .from("email_optouts").select("email").eq("email", email.toLowerCase()).limit(1);
    return error ? { optedOut: false, error: error.message } : { optedOut: (data?.length ?? 0) > 0 };
  } catch (e) {
    return { optedOut: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- unsubscribe.test`
Expected: PASS (2 assertions).

- [ ] **Step 5: Commit**

```bash
git add app/lib/pilot-invite/unsubscribe.server.ts app/lib/pilot-invite/__tests__/unsubscribe.test.ts
git commit -m "lib/pilot-invite: unsub token + Supabase opt-out store"
```

---

### Task 9: `invites.server.ts` — send log

**Files:** Create `app/lib/pilot-invite/invites.server.ts`; Test `app/lib/pilot-invite/__tests__/invites.test.ts`

- [ ] **Step 1: Write the failing test (mock the Supabase client)**

```ts
import { describe, it, expect, vi } from "vitest";

const insert = vi.fn().mockResolvedValue({ error: null });
const limit = vi.fn().mockResolvedValue({ data: [{ id: "1" }], error: null });
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      insert,
      select: () => ({ eq: () => ({ eq: () => ({ limit }) }) }),
    }),
  }),
}));

describe("invites store", () => {
  it("logInvite inserts a normalized row", async () => {
    const { logInvite } = await import("../invites.server");
    const r = await logInvite({ email: "A@B.co", firstName: "A", storeName: "B", status: "sent", resendId: "x" });
    expect(r.ok).toBe(true);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ email: "a@b.co", status: "sent", resend_id: "x" }));
  });
  it("hasSuccessfulInvite reports true when a sent row exists", async () => {
    const { hasSuccessfulInvite } = await import("../invites.server");
    expect(await hasSuccessfulInvite("a@b.co")).toEqual({ invited: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- invites.test`
Expected: FAIL — cannot find module `../invites.server`.

- [ ] **Step 3: Implement**

```ts
// app/lib/pilot-invite/invites.server.ts
// Append-only send log in Supabase (public.pilot_invites). Never throws (rule 12).
import { getSupabase } from "~/lib/supabase.server";

export interface InviteLogRow {
  email: string;
  firstName: string;
  storeName: string;
  status: "sent" | "failed";
  resendId?: string | null;
  error?: string | null;
}

export async function logInvite(row: InviteLogRow): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await getSupabase().from("pilot_invites").insert({
      email: row.email.toLowerCase(),
      first_name: row.firstName,
      store_name: row.storeName,
      status: row.status,
      resend_id: row.resendId ?? null,
      error: row.error ?? null,
    });
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function hasSuccessfulInvite(email: string): Promise<{ invited: boolean; error?: string }> {
  try {
    const { data, error } = await getSupabase()
      .from("pilot_invites").select("id").eq("email", email.toLowerCase()).eq("status", "sent").limit(1);
    return error ? { invited: false, error: error.message } : { invited: (data?.length ?? 0) > 0 };
  } catch (e) {
    return { invited: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- invites.test`
Expected: PASS (2 assertions).

- [ ] **Step 5: Commit**

```bash
git add app/lib/pilot-invite/invites.server.ts app/lib/pilot-invite/__tests__/invites.test.ts
git commit -m "lib/pilot-invite: pilot_invites send log"
```

---

### Task 10: Supabase migrations

**Files:** Create `supabase/migrations/<timestamp>_pilot_invites.sql`, `supabase/migrations/<timestamp>_email_optouts.sql`

- [ ] **Step 1: Create the migration files**

Use a UTC timestamp prefix matching existing files in `supabase/migrations/` (format `YYYYMMDDHHMMSS_name.sql`).

`<timestamp>_pilot_invites.sql`:
```sql
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
create index if not exists pilot_invites_email_idx     on public.pilot_invites (lower(email));
create index if not exists pilot_invites_created_at_idx on public.pilot_invites (created_at desc);
alter table public.pilot_invites enable row level security;
```

`<timestamp>_email_optouts.sql`:
```sql
create table if not exists public.email_optouts (
  email       text primary key,
  reason      text,
  source      text not null default 'pilot',
  created_at  timestamptz not null default now()
);
alter table public.email_optouts enable row level security;
```

- [ ] **Step 2: Apply to the Supabase project**

Apply each migration via the Supabase MCP `apply_migration` tool (name = file name, query = file contents), or `npx supabase db push` if the CLI is linked. Then verify both tables exist:
```sql
select table_name from information_schema.tables
where table_schema='public' and table_name in ('pilot_invites','email_optouts');
```
Expected: both rows returned. RLS enabled with no policies (service-role bypasses; anon/auth get nothing).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations
git commit -m "supabase: pilot_invites + email_optouts tables"
```

---

### Task 11: `email.server.ts` — render the delivered email

**Files:** Create `app/lib/pilot-invite/email.server.ts`; Test `app/lib/pilot-invite/__tests__/email.test.ts`
**Reference:** `docs/superpowers/specs/handoff-pilot/calderyn-pilot-email.html`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { renderPilotEmail } from "../email.server";

const base = "https://app.calderyncompany.com";
const unsub = `${base}/pilot/unsubscribe?token=tok`;

describe("renderPilotEmail", () => {
  it("fills both merge fields, leaving no template placeholders", () => {
    const { html } = renderPilotEmail({ firstName: "Jane", storeName: "Acme", baseUrl: base, unsubscribeUrl: unsub });
    expect(html).not.toMatch(/\{\{.*?\}\}/);
    expect(html).toContain("Jane");
    expect(html).toContain("Acme");
  });
  it("uses absolute https logo URLs and the real install CTA", () => {
    const { html } = renderPilotEmail({ firstName: "Jane", storeName: "Acme", baseUrl: base, unsubscribeUrl: unsub });
    expect(html).toContain(`${base}/pilot-mark-teal.png`);
    expect(html).toContain(`${base}/pilot-mark-white.png`);
    expect(html).toContain("https://apps.shopify.com/calderynextension");
    expect(html).not.toContain("assets/calderyn-mark"); // no leftover local paths
  });
  it("wires view-in-browser + unsubscribe links", () => {
    const { html } = renderPilotEmail({ firstName: "Jane", storeName: "Acme", baseUrl: base, unsubscribeUrl: unsub });
    expect(html).toContain(`${base}/pilot?first_name=Jane`);
    expect(html).toContain(unsub);
  });
  it("escapes HTML in the fields and personalizes the subject", () => {
    const out = renderPilotEmail({ firstName: "<b>", storeName: "A&B", baseUrl: base, unsubscribeUrl: unsub });
    expect(out.html).toContain("&lt;b&gt;");
    expect(out.html).toContain("A&amp;B");
    expect(out.subject).toBe("You're in, <b> — your free Calderyn pilot");
    expect(out.text).toContain("https://apps.shopify.com/calderynextension");
  });
  it("falls back to generic copy when fields are blank", () => {
    const out = renderPilotEmail({ firstName: "", storeName: "", baseUrl: base, unsubscribeUrl: unsub });
    expect(out.subject).toBe("You're in — your free Calderyn pilot");
    expect(out.html).toContain("there");
    expect(out.html).toContain("your store");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- email.test`
Expected: FAIL — cannot find module `../email.server`.

- [ ] **Step 3: Implement — port the reference email into a function**

Create `renderPilotEmail` with this exact wrapper, then paste the **body** of `docs/superpowers/specs/handoff-pilot/calderyn-pilot-email.html` into the template literal where indicated, applying the substitution table below. (The body is the committed reference; do not hand-rewrite the layout — keep the table structure, inline styles, and the `<!--[if mso]>` VML button intact.)

```ts
// app/lib/pilot-invite/email.server.ts
// Renders the delivered pilot email (table + inline styles, Outlook VML kept) with
// fields filled server-side and absolute https asset URLs. Ported from
// docs/superpowers/specs/handoff-pilot/calderyn-pilot-email.html.
import {
  escapeHtml, INSTALL_URL, FEEDBACK_URL, DEFAULT_FIRST_NAME, DEFAULT_STORE_NAME,
  markUrls, viewInBrowserUrl,
} from "./content";

export interface RenderEmailOpts {
  firstName: string;
  storeName: string;
  baseUrl: string;       // absolute origin, no trailing slash
  unsubscribeUrl: string; // absolute, tokened (or a plain preview URL)
}
export interface RenderedEmail { subject: string; html: string; text: string; }

export function renderPilotEmail(opts: RenderEmailOpts): RenderedEmail {
  const hasFirst = opts.firstName.trim().length > 0;
  const firstRaw = hasFirst ? opts.firstName : DEFAULT_FIRST_NAME;
  const storeRaw = opts.storeName.trim().length > 0 ? opts.storeName : DEFAULT_STORE_NAME;
  const first = escapeHtml(firstRaw);
  const store = escapeHtml(storeRaw);
  const marks = markUrls(opts.baseUrl);
  const viewUrl = viewInBrowserUrl(opts.baseUrl, firstRaw, storeRaw);

  const subject = hasFirst
    ? `You're in, ${firstRaw} — your free Calderyn pilot`
    : "You're in — your free Calderyn pilot";

  const html = `<!DOCTYPE html>
<!-- … paste calderyn-pilot-email.html body here, with the substitutions below … -->`;

  const text = [
    `You're in${hasFirst ? `, ${firstRaw}` : ""}.`,
    `${storeRaw} has a free seat in the Calderyn beta — ad spend + inventory, watched together.`,
    ``,
    `Install free on Shopify: ${INSTALL_URL}`,
    `Share feedback: ${FEEDBACK_URL}`,
    ``,
    `View in browser: ${viewUrl}`,
    `Unsubscribe: ${opts.unsubscribeUrl}`,
    `— Eric, Kenneth & John, Calderyn`,
  ].join("\n");

  return { subject, html, text };
}
```

**Substitution table (apply while pasting the body into the `html` template literal):**

| In the reference HTML | Replace with |
|---|---|
| `{{first_name}}` (both occurrences) | `${first}` |
| `{{store_name}}` | `${store}` |
| `src="assets/calderyn-mark-teal.png"` | `src="${marks.teal}"` |
| `src="assets/calderyn-mark-white.png"` | `src="${marks.white}"` |
| footer `<a href="#" …>Unsubscribe</a>` | `<a href="${opts.unsubscribeUrl}" …>Unsubscribe</a>` |
| any literal backtick `` ` `` or `${` in the HTML | escape as `` \` `` / `\${` (none expected, but check) |

Add a **"View in browser"** link in the hidden preheader `<div>` near the top (after the existing preheader text), so it renders in-client without disturbing layout:
```html
<div style="display:none;max-height:0;overflow:hidden;">&nbsp;</div>
<div style="font-size:11px;line-height:16px;text-align:center;color:#9A9AA0;padding:0 0 6px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <a href="${viewUrl}" style="color:#9A9AA0;text-decoration:underline;">View in browser</a>
</div>
```
(Place this immediately inside the outer container `<td>` before the top-bar row.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- email.test`
Expected: PASS (5 assertions). If `no {{…}} placeholders` fails, a merge tag was missed.

- [ ] **Step 5: Commit**

```bash
git add app/lib/pilot-invite/email.server.ts app/lib/pilot-invite/__tests__/email.test.ts
git commit -m "lib/pilot-invite: render delivered onboarding email"
```

---

### Task 12: `landing.server.ts` — render the view-in-browser page

**Files:** Create `app/lib/pilot-invite/landing.server.ts`; Test `app/lib/pilot-invite/__tests__/landing.test.ts`
**Reference:** `docs/superpowers/specs/handoff-pilot/calderyn-pilot-web.html`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { renderPilotLanding } from "../landing.server";

const base = "https://app.calderyncompany.com";

describe("renderPilotLanding", () => {
  it("fills fields, leaves no placeholders, uses absolute logos + install CTA", () => {
    const html = renderPilotLanding({ firstName: "Jane", storeName: "Acme", baseUrl: base });
    expect(html).not.toMatch(/\{\{.*?\}\}/);
    expect(html).toContain("Jane");
    expect(html).toContain("Acme");
    expect(html).toContain(`${base}/pilot-mark-teal.png`);
    expect(html).toContain("https://apps.shopify.com/calderynextension");
  });
  it("escapes HTML and falls back when blank", () => {
    const html = renderPilotLanding({ firstName: "<x>", storeName: "", baseUrl: base });
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("your store");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- landing.test`
Expected: FAIL — cannot find module `../landing.server`.

- [ ] **Step 3: Implement — port the reference web page**

Same approach as Task 11. Paste the body of `calderyn-pilot-web.html` into the template literal, applying the same substitution table (`{{first_name}}`→`${first}`, `{{store_name}}`→`${store}`, `assets/…teal.png`→`${marks.teal}`; the web file uses only the teal mark). Keep the `<style>` block (`@keyframes`, hover rules) intact.

```ts
// app/lib/pilot-invite/landing.server.ts
// Renders the hosted "view in browser" twin of the onboarding email. Ported from
// docs/superpowers/specs/handoff-pilot/calderyn-pilot-web.html.
import { escapeHtml, DEFAULT_FIRST_NAME, DEFAULT_STORE_NAME, markUrls } from "./content";

export interface RenderLandingOpts { firstName: string; storeName: string; baseUrl: string; }

export function renderPilotLanding(opts: RenderLandingOpts): string {
  const first = escapeHtml(opts.firstName.trim() || DEFAULT_FIRST_NAME);
  const store = escapeHtml(opts.storeName.trim() || DEFAULT_STORE_NAME);
  const marks = markUrls(opts.baseUrl);
  return `<!DOCTYPE html>
<!-- … paste calderyn-pilot-web.html body here with the substitutions … -->`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- landing.test`
Expected: PASS (2 assertions).

- [ ] **Step 5: Commit**

```bash
git add app/lib/pilot-invite/landing.server.ts app/lib/pilot-invite/__tests__/landing.test.ts
git commit -m "lib/pilot-invite: render view-in-browser landing"
```

---

### Task 13: `GET /pilot` route

**Files:** Create `app/routes/pilot._index.tsx`; Test `app/routes/__tests__/pilot._index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { loader } from "../pilot._index";

afterEach(() => { delete process.env.PUBLIC_APP_URL; });

describe("GET /pilot", () => {
  it("returns personalized HTML", async () => {
    process.env.PUBLIC_APP_URL = "https://app.test";
    const res = await loader({ request: new Request("https://app.test/pilot?first_name=Jane&store_name=Acme"), params: {}, context: {} });
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Jane");
    expect(body).toContain("Acme");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- pilot._index.test`
Expected: FAIL — cannot find module `../pilot._index`.

- [ ] **Step 3: Implement**

```tsx
// app/routes/pilot._index.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { renderPilotLanding } from "~/lib/pilot-invite/landing.server";
import { appOrigin } from "~/lib/pilot-invite/origin.server";

export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
  const url = new URL(request.url);
  const html = renderPilotLanding({
    firstName: url.searchParams.get("first_name") ?? "",
    storeName: url.searchParams.get("store_name") ?? "",
    baseUrl: appOrigin(request),
  });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- pilot._index.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/routes/pilot._index.tsx app/routes/__tests__/pilot._index.test.ts
git commit -m "routes/pilot: view-in-browser landing route"
```

---

### Task 14: `GET /pilot/api/preview` route

**Files:** Create `app/routes/pilot.api.preview.tsx`; Test `app/routes/__tests__/pilot.api.preview.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { loader } from "../pilot.api.preview";

afterEach(() => { delete process.env.PUBLIC_APP_URL; });

describe("GET /pilot/api/preview", () => {
  it("returns email HTML for the given fields", async () => {
    process.env.PUBLIC_APP_URL = "https://app.test";
    const res = await loader({ request: new Request("https://app.test/pilot/api/preview?first_name=Jane&store_name=Acme"), params: {}, context: {} });
    const body = await res.text();
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(body).toContain("Jane");
    expect(body).toContain("https://apps.shopify.com/calderynextension");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- pilot.api.preview.test`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```tsx
// app/routes/pilot.api.preview.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { renderPilotEmail } from "~/lib/pilot-invite/email.server";
import { appOrigin } from "~/lib/pilot-invite/origin.server";

export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
  const url = new URL(request.url);
  const base = appOrigin(request);
  const { html } = renderPilotEmail({
    firstName: url.searchParams.get("first_name") ?? "",
    storeName: url.searchParams.get("store_name") ?? "",
    baseUrl: base,
    unsubscribeUrl: `${base}/pilot/unsubscribe`, // preview: untokened placeholder
  });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- pilot.api.preview.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/routes/pilot.api.preview.tsx app/routes/__tests__/pilot.api.preview.test.ts
git commit -m "routes/pilot: email preview endpoint"
```

---

### Task 15: `/pilot/unsubscribe` route (GET + POST)

**Files:** Create `app/routes/pilot.unsubscribe.tsx`; Test `app/routes/__tests__/pilot.unsubscribe.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const upsert = vi.fn().mockResolvedValue({ error: null });
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: () => ({ upsert }) }) }));
beforeEach(() => { process.env.PILOT_UNSUB_SECRET = "t"; upsert.mockClear(); });

describe("/pilot/unsubscribe", () => {
  it("400s an invalid token on GET", async () => {
    const { loader } = await import("../pilot.unsubscribe");
    const res = await loader({ request: new Request("https://app.test/pilot/unsubscribe?token=bad"), params: {}, context: {} });
    expect(res.status).toBe(400);
  });
  it("records the opt-out on POST with a valid token", async () => {
    const { signUnsubToken } = await import("~/lib/pilot-invite/unsubscribe.server");
    const { action } = await import("../pilot.unsubscribe");
    const token = await signUnsubToken("a@b.co");
    const res = await action({ request: new Request(`https://app.test/pilot/unsubscribe?token=${token}`, { method: "POST" }), params: {}, context: {} });
    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ email: "a@b.co" }), expect.anything());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- pilot.unsubscribe.test`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```tsx
// app/routes/pilot.unsubscribe.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { escapeHtml } from "~/lib/pilot-invite/content";
import { recordOptOut, verifyUnsubToken } from "~/lib/pilot-invite/unsubscribe.server";

function page(title: string, bodyHtml: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>${title}</title></head>
<body style="margin:0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#F4F5F8;color:#1D1D1F;">
<div style="max-width:480px;margin:80px auto;padding:32px;background:#fff;border-radius:18px;border:.5px solid rgba(0,0,0,.06);text-align:center;">
${bodyHtml}</div></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function tokenFrom(request: Request): string {
  return new URL(request.url).searchParams.get("token") ?? "";
}

export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
  const email = await verifyUnsubToken(tokenFrom(request));
  if (!email) return page("Invalid link", "<p>This unsubscribe link is invalid or expired.</p>", 400);
  return page(
    "Unsubscribe",
    `<h1 style="font-size:20px;">Unsubscribe</h1>
     <p style="color:#6E6E73;">Stop pilot onboarding emails to ${escapeHtml(email)}?</p>
     <form method="post">
       <button type="submit" style="background:#24556E;color:#fff;border:0;border-radius:999px;padding:13px 22px;font-size:15px;font-weight:650;cursor:pointer;">Unsubscribe</button>
     </form>`,
  );
}

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  const email = await verifyUnsubToken(tokenFrom(request));
  if (!email) return page("Invalid link", "<p>This unsubscribe link is invalid or expired.</p>", 400);
  const res = await recordOptOut(email, "one-click");
  if (!res.ok) return page("Try again", `<p>Could not process right now. Please retry.</p>`, 502);
  return page("Unsubscribed", `<h1 style="font-size:20px;">You're unsubscribed</h1><p style="color:#6E6E73;">${escapeHtml(email)} won't receive further pilot emails.</p>`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- pilot.unsubscribe.test`
Expected: PASS (2 assertions).

- [ ] **Step 5: Commit**

```bash
git add app/routes/pilot.unsubscribe.tsx app/routes/__tests__/pilot.unsubscribe.test.ts
git commit -m "routes/pilot: unsubscribe confirm + one-click"
```

---

### Task 16: `POST /pilot/api/send-invite` route

**Files:** Create `app/routes/pilot.api.send-invite.tsx`; Test `app/routes/__tests__/pilot.api.send-invite.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const sendEmail = vi.fn();
const isOptedOut = vi.fn();
const hasSuccessfulInvite = vi.fn();
const logInvite = vi.fn().mockResolvedValue({ ok: true });
vi.mock("~/lib/email/send.server", () => ({ sendEmail }));
vi.mock("~/lib/pilot-invite/unsubscribe.server", () => ({ isOptedOut, signUnsubToken: async () => "tok" }));
vi.mock("~/lib/pilot-invite/invites.server", () => ({ hasSuccessfulInvite, logInvite }));

const POST = (body: unknown, auth = "Bearer s3cret") =>
  new Request("https://app.test/pilot/api/send-invite", {
    method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PILOT_INVITE_SECRET = "s3cret";
  process.env.RESEND_API_KEY = "re_x";
  process.env.PILOT_FROM = "Calderyn <onboarding@calderyncompany.com>";
  process.env.PUBLIC_APP_URL = "https://app.test";
  isOptedOut.mockResolvedValue({ optedOut: false });
  hasSuccessfulInvite.mockResolvedValue({ invited: false });
  sendEmail.mockResolvedValue({ sent: true, id: "email_1" });
});

describe("POST /pilot/api/send-invite", () => {
  it("401s without a valid bearer", async () => {
    const { action } = await import("../pilot.api.send-invite");
    const res = await action({ request: POST({ email: "a@b.co", first_name: "A", store_name: "B" }, "Bearer nope"), params: {}, context: {} });
    expect(res.status).toBe(401);
  });
  it("400s an invalid body", async () => {
    const { action } = await import("../pilot.api.send-invite");
    const res = await action({ request: POST({ email: "x" }), params: {}, context: {} });
    expect(res.status).toBe(400);
  });
  it("409s a suppressed recipient", async () => {
    isOptedOut.mockResolvedValue({ optedOut: true });
    const { action } = await import("../pilot.api.send-invite");
    const res = await action({ request: POST({ email: "a@b.co", first_name: "A", store_name: "B" }), params: {}, context: {} });
    expect(res.status).toBe(409);
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it("fails closed (502) when the suppression check errors", async () => {
    isOptedOut.mockResolvedValue({ optedOut: false, error: "db down" });
    const { action } = await import("../pilot.api.send-invite");
    const res = await action({ request: POST({ email: "a@b.co", first_name: "A", store_name: "B" }), params: {}, context: {} });
    expect(res.status).toBe(502);
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it("sends, logs, and returns the resend id", async () => {
    const { action } = await import("../pilot.api.send-invite");
    const res = await action({ request: POST({ email: "a@b.co", first_name: "A", store_name: "B" }), params: {}, context: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, id: "email_1" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = sendEmail.mock.calls[0][0];
    expect(arg.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(logInvite).toHaveBeenCalledWith(expect.objectContaining({ status: "sent", resendId: "email_1" }));
  });
  it("short-circuits with alreadyInvited when skip_if_invited and a prior send exists", async () => {
    hasSuccessfulInvite.mockResolvedValue({ invited: true });
    const { action } = await import("../pilot.api.send-invite");
    const res = await action({ request: POST({ email: "a@b.co", first_name: "A", store_name: "B", skip_if_invited: true }), params: {}, context: {} });
    expect(await res.json()).toEqual({ sent: false, alreadyInvited: true });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- pilot.api.send-invite.test`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```tsx
// app/routes/pilot.api.send-invite.tsx
// POST-only, bearer-protected. Suppress-check (fail closed) → validate → render → send → log.
import type { ActionFunctionArgs } from "@remix-run/node";
import { isAuthorizedBearer } from "~/lib/cron-auth.server";
import { parseInviteInput } from "~/lib/pilot-invite/validate";
import { isOptedOut, signUnsubToken } from "~/lib/pilot-invite/unsubscribe.server";
import { hasSuccessfulInvite, logInvite } from "~/lib/pilot-invite/invites.server";
import { renderPilotEmail } from "~/lib/pilot-invite/email.server";
import { sendEmail } from "~/lib/email/send.server";
import { appOrigin } from "~/lib/pilot-invite/origin.server";

function j(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  if (request.method !== "POST") return j({ sent: false, error: "method not allowed" }, 405);
  if (!isAuthorizedBearer(request.headers.get("Authorization"), process.env.PILOT_INVITE_SECRET)) {
    return j({ sent: false, error: "unauthorized" }, 401);
  }

  let body: unknown;
  try { body = await request.json(); } catch { return j({ sent: false, error: "body: invalid JSON" }, 400); }
  const parsed = parseInviteInput(body);
  if (!parsed.ok) return j({ sent: false, error: parsed.error }, 400);
  const { email, firstName, storeName, skipIfInvited } = parsed.value;

  const supp = await isOptedOut(email);
  if (supp.error) return j({ sent: false, error: `suppression check failed: ${supp.error}` }, 502); // fail closed
  if (supp.optedOut) return j({ sent: false, error: "recipient unsubscribed" }, 409);

  if (skipIfInvited) {
    const prior = await hasSuccessfulInvite(email);
    if (prior.error) return j({ sent: false, error: `invite check failed: ${prior.error}` }, 502);
    if (prior.invited) return j({ sent: false, alreadyInvited: true }, 200);
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.PILOT_FROM;
  if (!apiKey || !from) return j({ sent: false, error: `missing ${!apiKey ? "RESEND_API_KEY" : "PILOT_FROM"}` }, 500);

  const base = appOrigin(request);
  const token = await signUnsubToken(email);
  const unsubscribeUrl = `${base}/pilot/unsubscribe?token=${encodeURIComponent(token)}`;
  const { subject, html, text } = renderPilotEmail({ firstName, storeName, baseUrl: base, unsubscribeUrl });

  const delivery = await sendEmail({
    apiKey, from, to: email, subject, html, text,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>, <mailto:unsubscribe@calderyncompany.com?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });

  const log = await logInvite({
    email, firstName, storeName,
    status: delivery.sent ? "sent" : "failed",
    resendId: delivery.id ?? null, error: delivery.error ?? null,
  });

  if (!delivery.sent) return j({ sent: false, error: delivery.error ?? "send failed" }, 502);
  if (!log.ok) return j({ sent: true, id: delivery.id, logWarning: log.error }, 200);
  return j({ sent: true, id: delivery.id }, 200);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- pilot.api.send-invite.test`
Expected: PASS (6 assertions).

- [ ] **Step 5: Commit**

```bash
git add app/routes/pilot.api.send-invite.tsx app/routes/__tests__/pilot.api.send-invite.test.ts
git commit -m "routes/pilot: bearer-protected send-invite endpoint"
```

---

### Task 17: Env docs + full pre-commit gate

**Files:** Modify `.env.example`

- [ ] **Step 1: Append new keys to `.env.example`**

```bash
# Pilot onboarding invite (app/routes/pilot.*)
PILOT_INVITE_SECRET=        # bearer token the /panel backend sends to /pilot/api/send-invite
PILOT_UNSUB_SECRET=         # HMAC key for unsubscribe tokens
PILOT_FROM=                 # e.g. "Calderyn <onboarding@calderyncompany.com>" (Resend-verified domain)
PUBLIC_APP_URL=             # optional; canonical app origin for absolute email URLs (else SHOPIFY_APP_URL / request origin)
```

- [ ] **Step 2: Run the full gate (paste real output; rule 12 — no asserting green without evidence)**

```bash
npm run typecheck   # tsc --noEmit → exit 0
npm run lint        # eslint → exit 0 (no warnings on new files)
npm test            # vitest run → all pass
npm run build       # remix vite:build → exit 0
```
Then run `/code-review` on the working tree and resolve blockers. Confirm `git diff --check` is clean and no stray `console.log`/`.only`/commented blocks were introduced.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "env: document pilot invite keys"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §4 file layout | 2–16 (all files) |
| §5.1 send contract (200/400/401/409/502 + alreadyInvited) | 16 |
| §5.2 preview | 14 |
| §5.3 view-in-browser | 12, 13 |
| §5.4 unsubscribe GET/POST | 8, 15 |
| §5.5 panel reads tables directly | 10 (tables exist; no endpoint, by design) |
| §6 personalization + escaping + fallbacks | 2, 11, 12 |
| §7 bearer auth / HMAC token / RLS / PII | 4, 8, 10, 16 |
| §8 logo hosting + resize + absolute URLs | 5, 6, 11 |
| §9 Supabase tables (not Prisma) | 10 |
| §10 sendEmail headers | 7 |
| §11 send flow ordering | 16 |
| §12 fail-visibly (fail-closed suppression, log warning) | 16 (+ tests) |
| §13 env vars | 17 |
| §14 testing | every task's Step 1 |

No gaps.

**2. Placeholder scan:** The only intentional `<PASTE …>` tokens are in Task 6 Step 3 (base64) and the two HTML-port template literals (Tasks 11/12), each with an explicit substitution table and a committed reference file + a test that fails if the paste is wrong (`no {{…}}` / PNG magic number). No "TBD/handle edge cases/add validation" placeholders.

**3. Type consistency:** `InviteInput` (validate.ts) → consumed in Task 16. `RenderEmailOpts`/`RenderedEmail` (email.server) used by Tasks 14, 16. `markUrls`/`viewInBrowserUrl`/`escapeHtml` (content.ts) used consistently in 11/12/15. `isAuthorizedBearer(authHeader, secret)` signature matches its call in Task 16. `logInvite`/`hasSuccessfulInvite`/`isOptedOut`/`recordOptOut`/`signUnsubToken`/`verifyUnsubToken` signatures match across 8/9/15/16. Consistent.

---

## Notes for the implementer
- **Feature isolation:** all work happens in this worktree on `feat/pilot-invite`. Do not switch to `main`.
- **Dashboard parity:** N/A — internal founder tool, exempt.
- **Out of scope:** the `/panel` UI, the marketing-site `/panel/*` proxy, the `/pilot-feedback` page. The teammate builds these against the contract in spec §5.
