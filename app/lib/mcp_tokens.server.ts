// app/lib/mcp_tokens.server.ts
//
// Server-only CRUD for the mcp_tokens table.
// The raw token is returned ONCE from createMcpToken(); thereafter only the
// prefix and hash live in the DB.

import { createHmac, randomBytes } from "node:crypto";
import { getSupabase, resolveShopId } from "./supabase.server";

// ---------------------------------------------------------------------------
// Phase 4: OAuth-specific token operations
// ---------------------------------------------------------------------------

import { newAccessToken, newRefreshToken } from "./mcp_oauth.server";

export interface McpTokenRow {
  id: string;
  shop_id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  created_by_user: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface CreatedToken {
  row: McpTokenRow;
  raw: string; // mcp_live_<32-char-base32> — shown once, never persisted.
}

function pepper(): string {
  const p = process.env.MCP_TOKEN_PEPPER;
  if (!p || p.length < 32) {
    throw new Error("MCP_TOKEN_PEPPER must be set to a 32+ char secret");
  }
  return p;
}

export function hashToken(raw: string): string {
  return createHmac("sha256", pepper()).update(raw).digest("hex");
}

const BASE32_ALPHA = "abcdefghijklmnopqrstuvwxyz234567";

function generateRaw(): { raw: string; prefix: string } {
  // 32 random bytes → 32 base32 chars, one char per byte. 256 % 32 === 0, so
  // `byte % 32` is unbiased. Full 160 bits of entropy with no repeated structure
  // (the previous `(body+body).slice(0,32)` duplicated the first half).
  const bytes = randomBytes(32);
  let body = "";
  for (let i = 0; i < bytes.length; i++) {
    body += BASE32_ALPHA[bytes[i] % 32];
  }
  const raw = `mcp_live_${body}`;
  const prefix = raw.slice(0, 13); // "mcp_live_" + first 4 body chars
  return { raw, prefix };
}

export async function listMcpTokens(
  shopDomain: string,
): Promise<McpTokenRow[]> {
  const shopId = await resolveShopId(shopDomain);
  const { data, error } = await getSupabase()
    .from("mcp_tokens")
    .select(
      "id, shop_id, name, token_prefix, scopes, created_by_user, created_at, last_used_at, revoked_at",
    )
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as McpTokenRow[];
}

export async function createMcpToken(opts: {
  shopDomain: string;
  name: string;
  createdByUser: string | null;
  scopes?: string[];
}): Promise<CreatedToken> {
  const shopId = await resolveShopId(opts.shopDomain);
  const { raw, prefix } = generateRaw();
  const token_hash = hashToken(raw);
  const { data, error } = await getSupabase()
    .from("mcp_tokens")
    .insert({
      shop_id: shopId,
      name: opts.name,
      token_hash,
      token_prefix: prefix,
      scopes: opts.scopes ?? ["read"],
      created_by_user: opts.createdByUser,
    })
    .select(
      "id, shop_id, name, token_prefix, scopes, created_by_user, created_at, last_used_at, revoked_at",
    )
    .single();
  if (error) throw error;
  return { row: data as McpTokenRow, raw };
}

export async function revokeMcpToken(opts: {
  shopDomain: string;
  tokenId: string;
}): Promise<void> {
  const shopId = await resolveShopId(opts.shopDomain);
  const { error } = await getSupabase()
    .from("mcp_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("id", opts.tokenId)
    .is("revoked_at", null);
  if (error) throw error;
}

export interface MintAccessTokenReq {
  client_id: string;
  client_name: string;
  shop_id: string;
  scopes: string[];
}

export interface MintAccessTokenResult {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: "Bearer";
  scope: string;
}

const ACCESS_TTL_SEC = 60 * 60 * 24 * 90; // 90d

export async function mintAccessToken(req: MintAccessTokenReq): Promise<MintAccessTokenResult> {
  const access_token = newAccessToken();
  const refresh_token = newRefreshToken();
  const token_hash = hashToken(access_token);
  const refresh_hash = hashToken(refresh_token);
  const expires_at = new Date(Date.now() + ACCESS_TTL_SEC * 1000).toISOString();
  const prefix = access_token.slice(0, 9); // "cala_" + first 4 body chars

  const { error } = await getSupabase()
    .from("mcp_tokens")
    .insert({
      shop_id: req.shop_id,
      name: `${req.client_name} (${req.client_id.slice(-8)})`,
      token_hash,
      token_prefix: prefix,
      scopes: req.scopes,
      auth_type: "oauth",
      client_id: req.client_id,
      expires_at,
      refresh_hash,
    })
    .select("id")
    .single();
  if (error) throw error;

  return {
    access_token,
    refresh_token,
    expires_in: ACCESS_TTL_SEC,
    token_type: "Bearer",
    scope: req.scopes.join(" "),
  };
}

// ---------------------------------------------------------------------------
// 4.2 rotateRefreshToken
// ---------------------------------------------------------------------------

export interface RotateRefreshReq {
  refresh_token: string;
  client_id: string;
}

function invalidGrantTokens(detail: string): Error {
  const e = new Error(`invalid_grant: ${detail}`) as Error & { code: string };
  e.code = "invalid_grant";
  return e;
}

export async function rotateRefreshToken(req: RotateRefreshReq): Promise<MintAccessTokenResult> {
  const old_refresh_hash = hashToken(req.refresh_token);
  const { data, error } = await getSupabase()
    .from("mcp_tokens")
    .select("id, shop_id, client_id, scopes, revoked_at, expires_at")
    .eq("refresh_hash", old_refresh_hash)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    // Refresh-token reuse detection (OAuth 2.1 / RFC 6819 §5.2.2.3): a token that
    // matches no current grant may be one we already rotated away. If it matches a
    // grant's PREVIOUS refresh hash, this is a replay of a consumed token — a theft
    // signal — so revoke the (still-active) grant and refuse, forcing re-auth.
    const sb = getSupabase();
    const { data: reused, error: rerr } = await sb
      .from("mcp_tokens")
      .select("id, revoked_at")
      .eq("prev_refresh_hash", old_refresh_hash)
      .maybeSingle();
    if (rerr) throw rerr;
    if (reused) {
      const r = reused as { id: string; revoked_at: string | null };
      if (!r.revoked_at) {
        await sb
          .from("mcp_tokens")
          .update({ revoked_at: new Date().toISOString(), refresh_hash: null })
          .eq("id", r.id)
          .is("revoked_at", null);
      }
      throw invalidGrantTokens("refresh_token reuse detected; grant revoked");
    }
    throw invalidGrantTokens("unknown refresh_token");
  }
  const row = data as { id: string; shop_id: string; client_id: string | null; scopes: string[]; revoked_at: string | null; expires_at: string | null };
  if (row.client_id !== req.client_id) throw invalidGrantTokens("client_id mismatch");
  if (row.revoked_at) throw invalidGrantTokens("revoked");
  // The refresh token lives exactly as long as the grant it belongs to.
  // Without this check an expired (but unrevoked) grant could rotate forever.
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    throw invalidGrantTokens("expired");
  }

  const new_access = newAccessToken();
  const new_refresh = newRefreshToken();
  const new_token_hash = hashToken(new_access);
  const new_refresh_hash = hashToken(new_refresh);
  const new_expires_at = new Date(Date.now() + ACCESS_TTL_SEC * 1000).toISOString();
  const new_prefix = new_access.slice(0, 9);

  const { data: updated, error: uerr } = await getSupabase()
    .from("mcp_tokens")
    .update({
      token_hash: new_token_hash,
      refresh_hash: new_refresh_hash,
      prev_refresh_hash: old_refresh_hash,
      token_prefix: new_prefix,
      expires_at: new_expires_at,
    })
    .eq("id", row.id)
    .eq("refresh_hash", old_refresh_hash)
    .select("id");
  if (uerr) throw uerr;
  if (!Array.isArray(updated) || updated.length === 0) throw invalidGrantTokens("concurrent rotation");

  return {
    access_token: new_access,
    refresh_token: new_refresh,
    expires_in: ACCESS_TTL_SEC,
    token_type: "Bearer",
    scope: row.scopes.join(" "),
  };
}

// ---------------------------------------------------------------------------
// 4.3 listOauthGrants + revokeOauthGrant
// ---------------------------------------------------------------------------

export interface OauthGrantRow {
  id: string;
  name: string;
  client_id: string | null;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

export async function listOauthGrants(shopDomain: string): Promise<OauthGrantRow[]> {
  const shopId = await resolveShopId(shopDomain);
  const { data, error } = await getSupabase()
    .from("mcp_tokens")
    .select("id, name, client_id, scopes, created_at, last_used_at, expires_at")
    .eq("shop_id", shopId)
    .eq("auth_type", "oauth")
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as OauthGrantRow[];
}

export async function revokeOauthGrant(opts: { shopDomain: string; tokenId: string }): Promise<void> {
  const shopId = await resolveShopId(opts.shopDomain);
  const { error } = await getSupabase()
    .from("mcp_tokens")
    .update({ revoked_at: new Date().toISOString(), refresh_hash: null })
    .eq("shop_id", shopId)
    .eq("id", opts.tokenId)
    .eq("auth_type", "oauth")
    .is("revoked_at", null);
  if (error) throw error;
}
