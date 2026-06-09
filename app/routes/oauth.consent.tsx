// app/routes/oauth.consent.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  PENDING_COOKIE_NAME,
  verifyPendingOauth,
  getClient,
} from "~/lib/mcp_oauth.server";
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
