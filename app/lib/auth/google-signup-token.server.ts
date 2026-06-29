// app/lib/auth/google-signup-token.server.ts
//
// A short-lived signed token carrying a Google-verified identity across the
// "name your store" step for brand-new users. Stateless on purpose: no users
// row exists yet, so a password_reset_token row (which FKs to users) cannot be
// used. The HMAC signature + a 15 minute expiry make it unforgeable and bounded.

import { createHmac, timingSafeEqual } from "node:crypto";

const TTL_MS = 15 * 60 * 1000;

function secret(): string {
  const s = process.env.DASHBOARD_SESSION_PEPPER;
  if (!s || s.length < 32) throw new Error("DASHBOARD_SESSION_PEPPER must be set to a 32+ char secret");
  return s;
}

function sign(payloadB64: string): string {
  return createHmac("sha256", secret()).update(payloadB64).digest("base64url");
}

export function signGoogleSignup(payload: { sub: string; email: string }): string {
  const body = { sub: payload.sub, email: payload.email, exp: Date.now() + TTL_MS };
  const b64 = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${b64}.${sign(b64)}`;
}

export function verifyGoogleSignup(token: string): { sub: string; email: string } | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  try {
    const expected = Buffer.from(sign(b64));
    const got = Buffer.from(sig);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
    const body = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as { sub?: string; email?: string; exp?: number };
    if (!body.sub || !body.email || typeof body.exp !== "number") return null;
    if (body.exp <= Date.now()) return null;
    return { sub: body.sub, email: body.email };
  } catch {
    return null;
  }
}
