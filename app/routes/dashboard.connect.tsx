// app/routes/dashboard.connect.tsx
//
// Dashboard-surface parity for the embedded /app/connect consent screen.
//
// A merchant who lives in the web dashboard approves the Claude.ai connector
// here. The signed pending JWT (`?t=`) carries the OAuth request context; the
// approving shop comes from the authenticated dashboard session
// (requireDashboardSession), NEVER from the token. Same invariant as
// /app/connect — that is what closes the OAuth pre-seed High on this surface.
//
// Unlike the embedded route, the dashboard is top-level (not an iframe), so a
// plain 302 to the client's redirect_uri is sufficient — no window.top dance.
import type { ActionFunctionArgs, LoaderFunctionArgs, LinksFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";

import {
  getSessionFromRequest,
  requireDashboardSession,
} from "~/lib/dashboard/session.server";
import { jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import {
  buildAuthCodeRedirect,
  buildDenyRedirect,
  destinationHost,
  getClient,
  issueAuthCode,
  verifyPendingOauth,
} from "~/lib/mcp_oauth.server";

import dashboardUtils from "~/styles/dashboard-utils.css?url";
import dashboard from "~/styles/dashboard.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: dashboardUtils },
  { rel: "stylesheet", href: dashboard },
];

const FLAG_ON = () => process.env.MCP_OAUTH_ENABLED === "true";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });

  const session = await getSessionFromRequest(request);
  if (!session) {
    // Preserve the connect URL (incl. ?t=) through sign-in so the token
    // survives the round-trip. The native signin page (default entry) honours
    // return_to on both its password action and its Google link; merchants who
    // sign in with Shopify reach /dashboard/login from there.
    const url = new URL(request.url);
    const returnTo = `/dashboard/connect${url.search}`;
    return redirect(`/dashboard/signin?return_to=${encodeURIComponent(returnTo)}`);
  }

  const token = new URL(request.url).searchParams.get("t") ?? "";
  let ctx;
  try {
    ctx = await verifyPendingOauth(token);
  } catch {
    return redirect("/dashboard");
  }

  const client = await getClient(ctx.client_id);
  if (!client) return redirect("/dashboard");

  return json({
    token,
    client_name: client.client_name,
    destinationHost: destinationHost(ctx.redirect_uri),
    scopes: ctx.scope.split(" ").filter(Boolean),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });

  requireSameOrigin(request);
  const session = await requireDashboardSession(request);

  const form = await request.formData();
  const token = String(form.get("t") ?? "");
  const intent = String(form.get("intent") ?? "");

  let ctx;
  try {
    ctx = await verifyPendingOauth(token);
  } catch {
    return jsonError(400, "invalid_token");
  }

  if (intent === "deny") {
    return redirect(buildDenyRedirect(ctx.redirect_uri, ctx.state), 302);
  }

  if (intent !== "allow") return jsonError(400, "invalid_intent");

  // Bind issuance to the authenticated dashboard session's shop.
  const code = await issueAuthCode({
    client_id: ctx.client_id,
    shop_id: session.shopId,
    redirect_uri: ctx.redirect_uri,
    code_challenge: ctx.code_challenge,
    scopes: ctx.scope.split(" ").filter(Boolean),
    state: ctx.state,
  });

  return redirect(buildAuthCodeRedirect(ctx.redirect_uri, code, ctx.state), 302);
};

export default function DashboardConnect() {
  const { token, client_name, destinationHost, scopes } = useLoaderData<typeof loader>() as {
    token: string;
    client_name: string;
    destinationHost: string;
    scopes: string[];
  };

  return (
    <main style={{ maxWidth: "32rem", margin: "12vh auto", padding: "0 1.5rem" }}>
      <div className="cd-card" style={{ padding: "1.5rem" }}>
        <h1 style={{ fontSize: "1.25rem", marginTop: 0 }}>Connect {client_name} to Calderyn</h1>
        <p>
          <strong>{client_name}</strong> is requesting read-only access to your Calderyn data.
        </p>
        <p>
          Data will be sent to: <strong>{destinationHost}</strong>
        </p>
        {scopes.includes("read") && (
          <p>Read your alerts, audit log, campaigns, SKUs, guardrails, and integration status.</p>
        )}
        <p style={{ opacity: 0.7 }}>You can disconnect this at any time from Settings.</p>
        <Form method="post" style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
          <input type="hidden" name="t" value={token} />
          <button type="submit" name="intent" value="allow" className="cd-btn cd-btn-primary">
            Allow
          </button>
          <button type="submit" name="intent" value="deny" className="cd-btn cd-btn-secondary">
            Deny
          </button>
        </Form>
      </div>
    </main>
  );
}
