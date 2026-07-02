// app/lib/storefront/visitor-cookie.server.ts
// First-party visitor/session identity for storefront live analytics
// (spec 2026-07-02-analytics-live-view-design.md). cd_vid: 1-year visitor id.
// cd_sid: 30-minute rolling session id carrying the is_returning flag frozen
// at session start. Opaque UUIDs only — never PII. Mirrors cart-cookie.server.
import { createCookie } from "react-router";
import { randomUUID } from "node:crypto";

const VID_NAME = "cd_vid";
const SID_NAME = "cd_sid";
const VID_MAX_AGE_SEC = 60 * 60 * 24 * 365;
export const SESSION_IDLE_SEC = 60 * 30;

function cookieOpts(maxAge: number) {
  const secret = process.env.SHOPIFY_API_SECRET ?? "";
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge,
    secrets: secret ? [secret] : [],
  };
}

const vidCookie = () => createCookie(VID_NAME, cookieOpts(VID_MAX_AGE_SEC));
const sidCookie = () => createCookie(SID_NAME, cookieOpts(SESSION_IDLE_SEC));

export interface VisitorSession {
  visitorId: string;
  sessionId: string;
  isReturning: boolean;
  /** Set-Cookie headers to append to the response (vid once, sid rolling). */
  headers: Headers;
}

const SID_VALUE_RE = /^([0-9a-f-]{36})\.(r|n)$/;

/** Read-or-create the visitor + session identity for this request. */
export async function ensureVisitorSession(request: Request): Promise<VisitorSession> {
  const cookieHeader = request.headers.get("Cookie");
  const vidRaw: unknown = await vidCookie().parse(cookieHeader);
  const sidRaw: unknown = await sidCookie().parse(cookieHeader);

  const hadVisitor = typeof vidRaw === "string" && vidRaw.length > 0;
  const visitorId = hadVisitor ? (vidRaw as string) : randomUUID();

  // The sid value is "<uuid>.r" | "<uuid>.n" — freezing the returning flag at
  // session start so a mid-session request can't flip it after the vid lands.
  const m = typeof sidRaw === "string" ? SID_VALUE_RE.exec(sidRaw) : null;
  const sessionId = m ? m[1] : randomUUID();
  const isReturning = m ? m[2] === "r" : hadVisitor;

  const headers = new Headers();
  if (!hadVisitor) {
    headers.append("Set-Cookie", await vidCookie().serialize(visitorId));
  }
  // Always re-commit the sid: rolling 30-minute inactivity expiry.
  headers.append(
    "Set-Cookie",
    await sidCookie().serialize(`${sessionId}.${isReturning ? "r" : "n"}`),
  );
  return { visitorId, sessionId, isReturning, headers };
}
