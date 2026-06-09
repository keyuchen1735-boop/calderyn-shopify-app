//
// Server-only OAuth 2.1 helpers for the Claude.ai connector flow.
// PKCE math + token/code generators here; CRUD helpers in later phases.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHA = "abcdefghijklmnopqrstuvwxyz234567";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** Constant-time PKCE verification. Rejects verifiers shorter than 43 chars (RFC §4.1). */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (verifier.length < 43 || verifier.length > 128) return false;
  const expected = Buffer.from(pkceChallenge(verifier));
  const actual = Buffer.from(challenge);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function base32(len: number): string {
  const bytes = randomBytes(len);
  let body = "";
  for (let i = 0; i < bytes.length; i++) body += BASE32_ALPHA[bytes[i] % 32];
  return body;
}

export function newClientId(): string {
  return `cal_client_${base32(16)}`;
}

export function newAuthCode(): string {
  return `calc_${base32(32)}`;
}

export function newAccessToken(): string {
  return `cala_${base32(32)}`;
}

export function newRefreshToken(): string {
  return `calr_${base32(32)}`;
}

/** Plain SHA256 (hex). Used for short-lived auth codes; access tokens use the pepper'd HMAC from mcp_tokens.server.ts. */
export function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
