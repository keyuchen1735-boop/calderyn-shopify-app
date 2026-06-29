// app/lib/auth/password.server.ts
//
// Password hashing with node:crypto scrypt (no third-party dependency). Stored
// format encodes the parameters so they can be tuned later without breaking old
// hashes: `scrypt$<N>$<r>$<p>$<saltHex>$<derivedHex>`.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 65536; // CPU/memory cost: 2^16 (~50-100ms), stronger than the old 2^14
const R = 8;
const P = 1;
const KEYLEN = 64;
// scrypt needs ~128*N*r bytes; node's default maxmem (32MB) is too low at N=2^16, so set it.
const MAXMEM = 128 * N * R * 2;

// Server-side PEPPER: HMAC the password with a secret BEFORE scrypt, so a
// database-only leak (hashes + salts, no env secret) is uncrackable. Dedicated
// PASSWORD_PEPPER, falling back to the session pepper; both must be 32+ chars.
// Add PASSWORD_PEPPER to .env.example.
function peppered(plain: string): Buffer {
  const secret = process.env.PASSWORD_PEPPER || process.env.DASHBOARD_SESSION_PEPPER;
  if (!secret || secret.length < 32) throw new Error("PASSWORD_PEPPER must be set to a 32+ char secret");
  return createHmac("sha256", secret).update(plain).digest();
}

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(peppered(plain), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    if (expected.length === 0) return false;
    const n = Number(nStr);
    const derived = scryptSync(peppered(plain), salt, expected.length, {
      N: n, r: Number(rStr), p: Number(pStr), maxmem: 128 * n * Number(rStr) * 2,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
