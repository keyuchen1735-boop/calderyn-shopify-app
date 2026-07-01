// Authenticate inbound ACP requests by HMAC over the RAW body (constant-time compare). The
// shared secret is provisioned during OpenAI/Stripe ACP merchant onboarding (ACP_SIGNING_SECRET).
// NOTE: confirm the exact header name + signing scheme against the onboarded ACP spec version;
// some versions sign `${timestamp}.${body}` and send a `Signature`/`timestamp` header pair.
// If so, fold the timestamp into the signed payload and reject stale timestamps here.
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyAcpSignature(rawBody: string, signatureHex: string, secret: string): boolean {
  if (!signatureHex || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "hex");
  let b: Buffer;
  try { b = Buffer.from(signatureHex, "hex"); } catch { return false; }
  return a.length === b.length && timingSafeEqual(a, b);
}
