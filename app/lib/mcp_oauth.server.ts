//
// Server-only OAuth 2.1 helpers for the Claude.ai connector flow.
// PKCE math + token/code generators here; CRUD helpers in later phases.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { getSupabase } from "./supabase.server";

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

// ---------------------------------------------------------------------------
// Phase 3: OAuth data layer (Supabase CRUD)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared helpers (non-exported)
// ---------------------------------------------------------------------------

function isHttpsUri(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function err(code: string, message: string): Error {
  const e = new Error(`${code}: ${message}`) as Error & { code: string };
  e.code = code;
  return e;
}

function invalidGrant(detail: string): Error {
  return err("invalid_grant", detail);
}

// ---------------------------------------------------------------------------
// 3.1 registerClient
// ---------------------------------------------------------------------------

export interface DcrRequest {
  client_name: string;
  redirect_uris: string[];
  software_id?: string;
  software_version?: string;
}

export interface DcrResponse {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
}

export async function registerClient(req: DcrRequest): Promise<DcrResponse> {
  const name = (req.client_name ?? "").trim();
  if (!name) throw err("INVALID_CLIENT_NAME", "client_name is required");
  if (!Array.isArray(req.redirect_uris) || req.redirect_uris.length === 0) {
    throw err("INVALID_REDIRECT_URI", "redirect_uris must be a non-empty array");
  }
  if (req.redirect_uris.length > 5) {
    throw err("TOO_MANY_REDIRECT_URIS", "at most 5 redirect_uris allowed");
  }
  for (const u of req.redirect_uris) {
    if (!isHttpsUri(u)) throw err("INVALID_REDIRECT_URI", `redirect_uri must be https: ${u}`);
  }

  const client_id = newClientId();
  const { data, error } = await getSupabase()
    .from("mcp_oauth_clients")
    .insert({
      client_id,
      client_name: name,
      redirect_uris: req.redirect_uris,
      token_endpoint_auth_method: "none",
      software_id: req.software_id ?? null,
      software_version: req.software_version ?? null,
    })
    .select("client_id, client_name, redirect_uris, token_endpoint_auth_method")
    .single();
  if (error) throw error;
  return data as DcrResponse;
}

// ---------------------------------------------------------------------------
// 3.2 getClient
// ---------------------------------------------------------------------------

export interface OauthClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
}

export async function getClient(clientId: string): Promise<OauthClientRow | null> {
  const { data, error } = await getSupabase()
    .from("mcp_oauth_clients")
    .select("client_id, client_name, redirect_uris, token_endpoint_auth_method")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw error;
  return (data as OauthClientRow | null) ?? null;
}

// ---------------------------------------------------------------------------
// 3.3 issueAuthCode
// ---------------------------------------------------------------------------

export interface IssueCodeReq {
  client_id: string;
  shop_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string[];
  state: string;
}

const CODE_TTL_SEC = 60;

export async function issueAuthCode(req: IssueCodeReq): Promise<string> {
  const raw = newAuthCode();
  const code_hash = sha256hex(raw);
  const expires_at = new Date(Date.now() + CODE_TTL_SEC * 1000).toISOString();
  const state_hint = req.state.slice(-8);
  const { error } = await getSupabase().from("mcp_oauth_codes").insert({
    code_hash,
    client_id: req.client_id,
    shop_id: req.shop_id,
    redirect_uri: req.redirect_uri,
    code_challenge: req.code_challenge,
    scopes: req.scopes,
    state_hint,
    expires_at,
  });
  if (error) throw error;
  return raw;
}

// ---------------------------------------------------------------------------
// Pending-OAuth JWT carrier (HS256, 10-min TTL)
//
// Signed by /oauth/authorize, carried in the ?t= URL param into the embedded
// /app/connect (and /dashboard/connect) consent routes. URL params survive the
// token-exchange even when the SameSite=None cookie dies across Vercel-alias
// domains. The JWT deliberately carries NO shop — the consent routes ALWAYS
// issue the auth code against the *authenticated session* shop. Keeping shop
// out of the token entirely is what makes the pre-seed High unreintroducible:
// there is nothing shop-shaped here for a future caller to bind issuance to.
// ---------------------------------------------------------------------------

export interface PendingOauthCtx {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  state: string;
}

function cookieKey(): Uint8Array {
  const hex = process.env.MCP_OAUTH_COOKIE_SECRET ?? "";
  if (hex.length < 64) throw new Error("MCP_OAUTH_COOKIE_SECRET must be 64+ hex chars");
  return new Uint8Array(Buffer.from(hex, "hex"));
}

const PENDING_TTL_SEC = 10 * 60;

export async function signPendingOauth(
  ctx: PendingOauthCtx,
  opts: { ttlSec?: number } = {},
): Promise<string> {
  const ttl = opts.ttlSec ?? PENDING_TTL_SEC;
  return new SignJWT({ ...ctx })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(cookieKey());
}

export async function verifyPendingOauth(token: string): Promise<PendingOauthCtx> {
  const { payload } = await jwtVerify(token, cookieKey(), { algorithms: ["HS256"] });
  return {
    client_id: String(payload.client_id),
    redirect_uri: String(payload.redirect_uri),
    code_challenge: String(payload.code_challenge),
    scope: String(payload.scope),
    state: String(payload.state),
  };
}

// ---------------------------------------------------------------------------
// Consent-decision redirect builders (shared by /app/connect + /dashboard/connect)
//
// Both consent surfaces hand the exact same shapes back to the OAuth client, so
// the assembly lives here — one chokepoint, no cross-surface drift, and the
// security-relevant "code goes to the client-registered redirect_uri carried in
// the signed ctx" rule is auditable in a single place.
// ---------------------------------------------------------------------------

/** Display host of a redirect_uri (validated as registered https upstream). */
export function destinationHost(redirectUri: string): string {
  try {
    return new URL(redirectUri).host;
  } catch {
    return redirectUri;
  }
}

/** Success: `redirect_uri?code=…[&state=…]`. */
export function buildAuthCodeRedirect(redirectUri: string, code: string, state: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

/** Denial: `redirect_uri?error=access_denied&error_description=…[&state=…]`. */
export function buildDenyRedirect(redirectUri: string, state: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", "access_denied");
  url.searchParams.set("error_description", "merchant denied authorization");
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

// ---------------------------------------------------------------------------
// 3.4 consumeAuthCode
// ---------------------------------------------------------------------------

export interface ConsumeCodeReq {
  raw_code: string;
  code_verifier: string;
  redirect_uri: string;
  client_id: string;
}

export interface ConsumedContext {
  shop_id: string;
  scopes: string[];
}

export async function consumeAuthCode(req: ConsumeCodeReq): Promise<ConsumedContext> {
  const code_hash = sha256hex(req.raw_code);
  const { data, error } = await getSupabase()
    .from("mcp_oauth_codes")
    .select("client_id, shop_id, redirect_uri, code_challenge, scopes, expires_at, consumed_at")
    .eq("code_hash", code_hash)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw invalidGrant("code not found");
  if ((data as { consumed_at: unknown }).consumed_at) throw invalidGrant("code already used");
  if (new Date((data as { expires_at: string }).expires_at).getTime() < Date.now()) {
    throw invalidGrant("code expired");
  }
  if ((data as { client_id: string }).client_id !== req.client_id)
    throw invalidGrant("client_id mismatch");
  if ((data as { redirect_uri: string }).redirect_uri !== req.redirect_uri)
    throw invalidGrant("redirect_uri mismatch");
  if (!verifyPkce(req.code_verifier, (data as { code_challenge: string }).code_challenge)) {
    throw invalidGrant("PKCE mismatch");
  }

  // Atomically claim the code. Only succeeds if consumed_at is still null.
  const { data: updated, error: uerr } = await getSupabase()
    .from("mcp_oauth_codes")
    .update({ consumed_at: new Date().toISOString() })
    .eq("code_hash", code_hash)
    .is("consumed_at", null)
    .select("code_hash");
  if (uerr) throw uerr;
  if (!Array.isArray(updated) || updated.length === 0) throw invalidGrant("code race lost");

  return {
    shop_id: (data as { shop_id: string }).shop_id,
    scopes: (data as { scopes: string[] }).scopes,
  };
}
