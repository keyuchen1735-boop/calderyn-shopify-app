// Constant-time bearer check for cron endpoints. Mirrors the engine's hardening
// (commit fcc96ec): compare with timingSafeEqual over equal-length buffers, and
// fail closed when the secret is unset.

import { timingSafeEqual } from "node:crypto";

export function isAuthorizedCron(authHeader: string | null, secret: string | undefined): boolean {
  if (!secret) return false;
  if (!authHeader) return false;
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // length itself isn't secret
  return timingSafeEqual(a, b);
}

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
