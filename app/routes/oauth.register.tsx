import type { ActionFunctionArgs } from "react-router";
import { json } from "~/lib/response.server";
import { registerClient } from "~/lib/mcp_oauth.server";
import { rateLimit, clientIpKey } from "~/lib/dashboard/http.server";

const FLAG_ON = () => process.env.MCP_OAUTH_ENABLED === "true";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  if (!(await rateLimit(clientIpKey(request, "oauth_register"), 10, 60 * 60 * 1000))) {
    return json(
      { error: "too_many_requests", error_description: "rate limit exceeded; try again later" },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      { error: "invalid_client_metadata", error_description: "body must be valid JSON" },
      { status: 400 },
    );
  }

  const payload = body as {
    client_name?: string;
    redirect_uris?: string[];
    software_id?: string;
    software_version?: string;
  };

  try {
    const out = await registerClient({
      client_name: payload.client_name ?? "",
      redirect_uris: payload.redirect_uris ?? [],
      software_id: payload.software_id,
      software_version: payload.software_version,
    });
    return json(out, { status: 201 });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const code = err.code ?? "invalid_client_metadata";
    const mapped =
      code === "INVALID_REDIRECT_URI"
        ? "invalid_redirect_uri"
        : code === "TOO_MANY_REDIRECT_URIS"
          ? "invalid_redirect_uri"
          : code === "INVALID_CLIENT_NAME"
            ? "invalid_client_metadata"
            : "invalid_client_metadata";
    return json(
      { error: mapped, error_description: err.message ?? "registration failed" },
      { status: 400 },
    );
  }
};

export const loader = () => new Response("Method Not Allowed", { status: 405 });
