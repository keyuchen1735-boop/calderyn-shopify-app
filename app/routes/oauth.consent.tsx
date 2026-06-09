// app/routes/oauth.consent.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  PENDING_COOKIE_NAME,
  verifyPendingOauth,
  getClient,
  issueAuthCode,
} from "~/lib/mcp_oauth.server";
import { resolveShopId } from "~/lib/supabase.server";
import { authenticate } from "../shopify.server";

const FLAG_ON = () => process.env.MCP_OAUTH_ENABLED === "true";

function readCookie(req: Request, name: string): string | null {
  const h = req.headers.get("cookie") ?? "";
  const m = h.match(new RegExp(`${name}=([^;]+)`));
  return m ? m[1] : null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });
  const { session } = await authenticate.admin(request);

  const raw = readCookie(request, PENDING_COOKIE_NAME);
  if (!raw) return redirect("/app");

  let ctx;
  try {
    ctx = await verifyPendingOauth(raw);
  } catch {
    return redirect("/app");
  }
  if (ctx.shop !== session.shop) return redirect("/app");

  const client = await getClient(ctx.client_id);
  if (!client) return redirect("/app");

  return json({
    client_name: client.client_name,
    client_id: client.client_id,
    shop: session.shop,
    scopes: ctx.scope.split(" ").filter(Boolean),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });
  const { session } = await authenticate.admin(request);
  const raw = readCookie(request, PENDING_COOKIE_NAME);
  if (!raw) return redirect("/app");
  let ctx;
  try {
    ctx = await verifyPendingOauth(raw);
  } catch {
    return redirect("/app");
  }
  if (ctx.shop !== session.shop) return redirect("/app");

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  const clearCookie = `${PENDING_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

  if (intent === "deny") {
    const url = new URL(ctx.redirect_uri);
    url.searchParams.set("error", "access_denied");
    url.searchParams.set("error_description", "merchant denied authorization");
    if (ctx.state) url.searchParams.set("state", ctx.state);
    const headers = new Headers({ location: url.toString() });
    headers.append("set-cookie", clearCookie);
    return new Response(null, { status: 302, headers });
  }

  if (intent !== "allow") return new Response("invalid_intent", { status: 400 });

  const shop_id = await resolveShopId(session.shop);
  const code = await issueAuthCode({
    client_id: ctx.client_id,
    shop_id,
    redirect_uri: ctx.redirect_uri,
    code_challenge: ctx.code_challenge,
    scopes: ctx.scope.split(" ").filter(Boolean),
    state: ctx.state,
  });

  const url = new URL(ctx.redirect_uri);
  url.searchParams.set("code", code);
  if (ctx.state) url.searchParams.set("state", ctx.state);
  const headers = new Headers({ location: url.toString() });
  headers.append("set-cookie", clearCookie);
  return new Response(null, { status: 302, headers });
};
