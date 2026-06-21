// app/lib/social-digest/token.server.ts
//
// Signed, single-use, version-scoped tokens for the email Approve/Reject links.
// A token authorizes one action on one digest at one regeneration version. The
// HMAC proves the link came from us; `version` (= the row's regen_count at send
// time) means a regenerated drop's new email invalidates the previous round's
// links. Replay within a version is blocked by the row's `consumed_at` (caller's
// job, in the POST handler) — the token itself is stateless.
//
// Tokens are only validated server-side. The link is GET (shows a confirmation
// page); the mutation is a POST from that page — so email link-prefetch bots
// can't trigger an action (see the spec's link-prefetch constraint).

import { createHmac, timingSafeEqual } from "node:crypto";

export type SocialAction = "approve" | "reject";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface TokenPayload {
  id: string;
  action: SocialAction;
  version: number;
  /** For approve: which founder's LinkedIn to post to (their email). */
  owner?: string;
}

function secret(override?: string): string {
  const s = override ?? process.env.SOCIAL_ACTION_SECRET ?? process.env.CRON_SECRET;
  if (!s) {
    throw new Error("No signing secret: set SOCIAL_ACTION_SECRET (or CRON_SECRET).");
  }
  return s;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(payload: string, key: string): string {
  return b64url(createHmac("sha256", key).update(payload).digest());
}

function isAction(v: string): v is SocialAction {
  return v === "approve" || v === "reject";
}

/** Build a signed token authorizing `action` on digest `id` at `version`. */
export function signActionToken(
  id: string,
  action: SocialAction,
  version: number,
  opts?: { ttlMs?: number; nowMs?: number; secret?: string; owner?: string },
): string {
  const now = opts?.nowMs ?? Date.now();
  const exp = now + (opts?.ttlMs ?? DEFAULT_TTL_MS);
  // owner (an email, no ":") is an optional 5th segment for per-founder approve tokens.
  const base = `${id}:${action}:${version}:${exp}`;
  const payload = opts?.owner ? `${base}:${opts.owner}` : base;
  const sig = sign(payload, secret(opts?.secret));
  return `${b64url(Buffer.from(payload))}.${sig}`;
}

/**
 * Verify a token. Returns the payload if the signature is valid and unexpired,
 * else null. Does NOT check single-use — the caller compares `version` against
 * the row and checks `consumed_at`.
 */
export function verifyActionToken(
  token: string,
  opts?: { nowMs?: number; secret?: string },
): TokenPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  let payload: string;
  try {
    payload = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return null;
  }

  const expectedSig = sign(payload, secret(opts?.secret));
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const parts = payload.split(":");
  if (parts.length < 4) return null;
  const [id, action, versionStr, expStr] = parts;
  // owner may itself contain ":" in pathological emails — rejoin the remainder.
  const owner = parts.length > 4 ? parts.slice(4).join(":") : undefined;
  const version = Number(versionStr);
  const exp = Number(expStr);
  if (!id || !isAction(action) || !Number.isInteger(version) || !Number.isFinite(exp)) return null;

  const now = opts?.nowMs ?? Date.now();
  if (now >= exp) return null;

  return owner ? { id, action, version, owner } : { id, action, version };
}
