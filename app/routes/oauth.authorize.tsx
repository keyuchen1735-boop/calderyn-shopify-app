// app/routes/oauth.authorize.tsx
//
// OAuth 2.1 authorize endpoint for the Claude.ai MCP connector.
//
// This endpoint NO LONGER pre-seeds any consumable state. It validates the
// OAuth request, mints a signed pending JWT carrying the request context, and
// renders an interstitial that deep-links the merchant into the embedded,
// authenticated consent route (/app/connect?t=<jwt>). Consent + code issuance
// happen there, bound to the merchant's authenticated session shop — which is
// what closes the pre-seed High. No DB row, no cookie, no /app auto-route.
import { useMemo } from "react";
import type { MouseEvent } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import oauthConnectStyles from "~/styles/oauth-connect.css?url";
import { getClient, signPendingOauth } from "~/lib/mcp_oauth.server";
import { buildAppConnectUrl, SHOP_RE } from "~/lib/connect-deeplink";
import { readShopHintCookie } from "~/lib/connect-deeplink.server";

const FLAG_ON = () => process.env.MCP_OAUTH_ENABLED === "true";

interface AuthorizeParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  state: string;
  shop?: string;
}

function readParams(url: URL): AuthorizeParams {
  const p = (k: string) => url.searchParams.get(k) ?? "";
  return {
    response_type: p("response_type"),
    client_id: p("client_id"),
    redirect_uri: p("redirect_uri"),
    code_challenge: p("code_challenge"),
    code_challenge_method: p("code_challenge_method") || "S256",
    scope: p("scope") || "read",
    state: p("state"),
    shop: url.searchParams.get("shop") ?? undefined,
  };
}

function redirectError(
  params: AuthorizeParams,
  code: "invalid_request" | "unsupported_response_type",
  detail: string,
): Response {
  const url = new URL(params.redirect_uri);
  url.searchParams.set("error", code);
  url.searchParams.set("error_description", detail);
  if (params.state) url.searchParams.set("state", params.state);
  return redirect(url.toString(), 302);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });

  const url = new URL(request.url);
  const params = readParams(url);

  // Before we can safely redirect to redirect_uri with an error, we must validate
  // client_id + redirect_uri. Other errors get redirected per OAuth spec.
  if (
    !params.response_type ||
    !params.client_id ||
    !params.redirect_uri ||
    !params.code_challenge ||
    !params.state
  ) {
    return new Response("invalid_request: missing required parameter", { status: 400 });
  }

  const client = await getClient(params.client_id);
  if (!client) return new Response("invalid_request: unknown client_id", { status: 400 });
  if (!client.redirect_uris.includes(params.redirect_uri)) {
    return new Response("invalid_request: redirect_uri not registered", { status: 400 });
  }

  // From here on, redirect_uri is safe to redirect to.
  if (params.response_type !== "code") {
    return redirectError(params, "unsupported_response_type", "only 'code' is supported");
  }
  if (params.code_challenge_method !== "S256") {
    return redirectError(params, "invalid_request", "code_challenge_method must be S256");
  }
  if (params.scope && params.scope.split(" ").some((s) => s !== "read")) {
    return redirectError(params, "invalid_request", "only scope=read is supported in v1");
  }

  // Mint the signed pending JWT. It carries the OAuth request context across the
  // embedded token-exchange (URL params survive even when the SameSite=None
  // cookie dies across Vercel-alias domains). It carries NO shop — the consent
  // routes ALWAYS issue against the authenticated session shop. The `?shop=`
  // hint below is used only to build a nicer deep link, never put in the token.
  const shopHint = url.searchParams.get("shop")?.toLowerCase();
  const hintShop = shopHint && SHOP_RE.test(shopHint) ? shopHint : null;
  // Fall back to the remembered shop (written by /oauth/login on this same
  // origin). READ ONLY: /oauth/authorize must never Set-Cookie — that no-pre-seed
  // rule is the PR #107 invariant.
  const validShop = hintShop ?? readShopHintCookie(request);
  const jwt = await signPendingOauth({
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    scope: params.scope,
    state: params.state,
  });

  return json({
    client_name: client.client_name,
    token: jwt,
    apiKey: process.env.SHOPIFY_API_KEY ?? "",
    appUrl: process.env.SHOPIFY_APP_URL ?? "",
    dashboardUrl: process.env.DASHBOARD_PUBLIC_URL ?? "https://calderyncompany.com",
    shop: validShop,
  });
};

export const links = () => [{ rel: "stylesheet", href: oauthConnectStyles }];

type InterstitialData = {
  client_name: string;
  token: string;
  apiKey: string;
  appUrl: string;
  dashboardUrl: string;
  shop: string | null;
};

/** The Claude app mark (Simple Icons, CC0), rendered in white on its coral tile. */
function ClaudeMark() {
  return (
    <svg className="cdc-claude-mark" viewBox="0 0 24 24" fill="#fff" role="img" aria-label="Claude">
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

/** The Calderyn hex brand mark — same glyph as the dashboard shell. */
function CalderynHex() {
  return (
    <svg className="cdc-hex" viewBox="0 0 32 32" fill="none" role="img" aria-label="Calderyn">
      <path d="M16 2 L28.12 9 L28.12 23 L16 30 L3.88 23 L3.88 9 Z" fill="#24556E" />
      <path
        d="M24.4 11.15 L16 6.3 L7.6 11.15 L7.6 20.85 L16 25.7 L24.4 20.85"
        stroke="#fff"
        strokeWidth="3.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function AuthorizeInterstitial() {
  const data = useLoaderData<typeof loader>() as InterstitialData;

  const knownShop = data.shop;
  const directUrl = useMemo(
    () => buildAppConnectUrl({ shop: knownShop, apiKey: data.apiKey, appUrl: data.appUrl, token: data.token }),
    [data, knownShop],
  );
  const loginUrl = `${data.appUrl}/oauth/login?t=${encodeURIComponent(data.token)}`;
  const dashboardUrl = `${data.dashboardUrl}/dashboard/connect?t=${encodeURIComponent(data.token)}`;
  const clientInitial = (data.client_name?.trim()?.[0] ?? "C").toUpperCase();
  const isClaude = /claude/i.test(data.client_name ?? "");

  // The deep-link and dashboard targets must navigate the top window (this page
  // can be opened inside an OAuth popup/iframe). Real hrefs are kept as the
  // JS-disabled fallback; onClick takes over to break out of any frame.
  const go = (target: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    try {
      if (typeof window !== "undefined" && window.top) {
        window.top.location.href = target;
        return;
      }
    } catch {
      // top-window navigation may be blocked; fall through to same-window.
    }
    window.location.href = target;
  };

  return (
    <div className="cdc-page">
      <main className="cdc-card">
        <div className="cdc-hero" aria-hidden="true">
          <div className={`cdc-tile ${isClaude ? "cdc-tile--claude" : "cdc-tile--mono"}`}>
            {isClaude ? <ClaudeMark /> : <span className="cdc-tile-initial">{clientInitial}</span>}
          </div>
          <div className="cdc-connect">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </div>
          <div className="cdc-tile">
            <CalderynHex />
          </div>
        </div>

        <h1 className="cdc-title">Connect {data.client_name} to Calderyn</h1>
        <p className="cdc-body">
          <strong>{data.client_name}</strong> wants read-only access to your Calderyn data — your
          alerts, audit log, campaigns, SKUs, and integration status.
        </p>

        <div className="cdc-trust">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="11" width="16" height="9" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          Read-only access
        </div>

        <div className="cdc-actions">
          {knownShop ? (
            <a className="cdc-btn cdc-btn-primary" href={directUrl} onClick={go(directUrl)}>
              Approve in Shopify admin
            </a>
          ) : (
            <a className="cdc-btn cdc-btn-primary" href={loginUrl}>
              Sign in with Shopify
            </a>
          )}
          <a className="cdc-link-btn" href={dashboardUrl} onClick={go(dashboardUrl)}>
            Prefer the web dashboard? Approve there
          </a>
        </div>

        <p className="cdc-foot">
          We confirm it&apos;s really you inside your authenticated account, then connect. You can
          disconnect anytime from Settings.
        </p>
      </main>
    </div>
  );
}
