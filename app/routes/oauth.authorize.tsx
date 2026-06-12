// app/routes/oauth.authorize.tsx
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import {
  AppProvider as PolarisAppProvider,
  Button,
  Card,
  FormLayout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import {
  getClient,
  signPendingOauth,
  setPendingOauth,
  PENDING_COOKIE_NAME,
  PENDING_COOKIE_OPTS,
} from "~/lib/mcp_oauth.server";

const FLAG_ON = () => process.env.MCP_OAUTH_ENABLED === "true";

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

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

// Shared validation of the OAuth grant shape (response_type / PKCE method / scope).
// Returns a stable error code on violation, or null when the params are acceptable.
// The loader maps these to redirect_uri errors; the action maps them to plain 400s.
function validateGrantShape(
  params: AuthorizeParams,
): "unsupported_response_type" | "invalid_request" | null {
  if (params.response_type !== "code") return "unsupported_response_type";
  if (params.code_challenge_method !== "S256") return "invalid_request";
  if (params.scope && params.scope.split(" ").some((s) => s !== "read")) return "invalid_request";
  return null;
}

function redirectError(
  params: AuthorizeParams,
  code: "invalid_request" | "unsupported_response_type" | "access_denied",
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

  // ?shop= shortcut: if shop is already in the URL, skip the form and start the handoff.
  const shop = url.searchParams.get("shop")?.toLowerCase();
  if (shop && SHOP_RE.test(shop)) {
    // Write authoritative server-side state. Cookie is best-effort fallback
    // for same-domain testing — modern Chrome blocks 3P cookies across the
    // Vercel-alias domain change to the embedded admin iframe.
    await setPendingOauth({
      shop_domain: shop,
      client_id: params.client_id,
      redirect_uri: params.redirect_uri,
      code_challenge: params.code_challenge,
      scope: params.scope,
      client_state: params.state,
    });
    const jwt = await signPendingOauth({
      client_id: params.client_id,
      redirect_uri: params.redirect_uri,
      code_challenge: params.code_challenge,
      scope: params.scope,
      state: params.state,
      shop,
    });
    const headers = new Headers();
    headers.append("set-cookie", `${PENDING_COOKIE_NAME}=${jwt}; ${PENDING_COOKIE_OPTS}`);
    headers.set("location", `/auth/login?shop=${encodeURIComponent(shop)}`);
    return new Response(null, { status: 302, headers });
  }

  return json({
    phase: "pick-shop",
    client_name: client.client_name,
    client_id: client.client_id,
    response_type: params.response_type,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    code_challenge_method: params.code_challenge_method,
    scope: params.scope,
    state: params.state,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  // TODO(security): bind pending OAuth to an unguessable transaction id, not shop_domain only — see consent pre-seed finding.
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });

  const form = await request.formData();
  const params: AuthorizeParams = {
    response_type: String(form.get("response_type") ?? ""),
    client_id: String(form.get("client_id") ?? ""),
    redirect_uri: String(form.get("redirect_uri") ?? ""),
    code_challenge: String(form.get("code_challenge") ?? ""),
    code_challenge_method: String(form.get("code_challenge_method") ?? "S256"),
    scope: String(form.get("scope") ?? "read"),
    state: String(form.get("state") ?? ""),
    shop: String(form.get("shop") ?? "").trim().toLowerCase(),
  };

  // Re-validate (this endpoint is also reachable via direct POST)
  const client = await getClient(params.client_id);
  if (!client) return new Response("invalid_request", { status: 400 });
  if (!client.redirect_uris.includes(params.redirect_uri)) {
    return new Response("invalid_request", { status: 400 });
  }
  // The loader guards response_type/code_challenge_method/scope, but this action
  // is reachable via direct POST and must apply the same guards before pre-seeding.
  const grantError = validateGrantShape(params);
  if (grantError) return new Response(grantError, { status: 400 });
  // The loader rejects a missing code_challenge as a required-param error; the
  // direct-POST path must too, or it pre-seeds an unusable PKCE-less grant.
  if (!params.code_challenge) return new Response("invalid_request", { status: 400 });
  if (!params.shop || !SHOP_RE.test(params.shop)) {
    return new Response("invalid_shop", { status: 400 });
  }

  // Write authoritative server-side state (carries across Vercel-alias domains).
  await setPendingOauth({
    shop_domain: params.shop,
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    scope: params.scope,
    client_state: params.state,
  });
  const jwt = await signPendingOauth({
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    scope: params.scope,
    state: params.state,
    shop: params.shop,
  });

  const headers = new Headers();
  headers.append("set-cookie", `${PENDING_COOKIE_NAME}=${jwt}; ${PENDING_COOKIE_OPTS}`);
  headers.set("location", `/auth/login?shop=${encodeURIComponent(params.shop)}`);
  return new Response(null, { status: 302, headers });
};

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

type PickShopData = {
  phase: "pick-shop";
  client_name: string;
  client_id: string;
  response_type: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  state: string;
};

const HIDDEN_FIELDS: Array<keyof PickShopData> = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "state",
];

export default function AuthorizePickShop() {
  const data = useLoaderData<typeof loader>() as PickShopData;
  const [shop, setShop] = useState("");
  return (
    <PolarisAppProvider i18n={polarisTranslations}>
      <Page title="Connect Claude.ai">
        <Card>
          <Form method="post">
            <FormLayout>
              <Text variant="bodyMd" as="p">
                <b>{data.client_name}</b> is asking to connect to your Calderyn data. Enter your shop
                domain to sign in and approve.
              </Text>
              <TextField
                type="text"
                name="shop"
                label="Shop domain"
                helpText="example.myshopify.com"
                value={shop}
                onChange={setShop}
                autoComplete="on"
              />
              {HIDDEN_FIELDS.map((k) => (
                <input key={k} type="hidden" name={k} value={data[k] ?? ""} />
              ))}
              <Button submit>Continue</Button>
            </FormLayout>
          </Form>
        </Card>
      </Page>
    </PolarisAppProvider>
  );
}
