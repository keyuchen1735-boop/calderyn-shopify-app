// Shippo OAuth 2.0 (authorization-code grant, co-branded — the merchant owns the
// Shippo account + billing). Plan 02 §5.
//
// Mirrors app/lib/quickbooks/oauth.server.ts: pure helpers with an injected fetcher
// so URL building and token parsing are unit-testable without network.
//
// Unlike QuickBooks, the Shippo access token NEVER expires and there is no refresh
// token (Shippo: "remains valid forever"). The exchange returns access_token in the
// form "oauth.<token>", token_type "bearer", scope "*". Callers store the access
// token encrypted with token_expires_at = null.
//
// HARD GATE (Plan 02 §3.2 / §11 risk #1): the client_id/client_secret and the
// redirect_uri are NOT self-serve — they require Shippo partner-program approval
// (https://goshippo.com/become-a-shippo-partner) before any redirect works.

const AUTH_ENDPOINT = "https://goshippo.com/oauth/authorize";
const TOKEN_ENDPOINT = "https://api.goshippo.com/oauth/access_token";
const SCOPE = "*"; // Shippo OAuth uses a single wildcard scope.

export function buildAuthUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    scope: SCOPE,
    state: opts.state,
    redirect_uri: opts.redirectUri,
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

export type ShippoTokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  // Shippo tokens do not expire; these are not expected but parsed defensively.
  account_id?: string;
  owner?: string;
  error?: string;
  error_description?: string;
};

// Injected so tests supply fakes; the real caller POSTs to the token endpoint.
export type TokenFetcher = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<ShippoTokenResponse>;

export type ParsedShippoTokens = {
  accessToken: string; // "oauth.<token>"
  scope: string;
  // The Shippo account / owner id if the exchange returned one, else null.
  accountId: string | null;
};

function parseTokens(res: ShippoTokenResponse): ParsedShippoTokens {
  if (res.error || !res.access_token) {
    throw new Error(
      `Shippo OAuth error: ${res.error_description ?? res.error ?? "no access_token returned"}`,
    );
  }
  return {
    accessToken: res.access_token,
    scope: res.scope ?? SCOPE,
    accountId: res.account_id ?? res.owner ?? null,
  };
}

export async function exchangeCodeForToken(
  fetcher: TokenFetcher,
  opts: { clientId: string; clientSecret: string; redirectUri: string; code: string },
): Promise<ParsedShippoTokens> {
  // Shippo expects the approved redirect_uri echoed back on the exchange, and the
  // client credentials in the form body (not Basic auth, per the Shippo OAuth docs).
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
  }).toString();

  const res = await fetcher(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  return parseTokens(res);
}
