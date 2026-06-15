// app/routes/pilot.api.preview.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { renderPilotEmail } from "~/lib/pilot-invite/email.server";
import { appOrigin } from "~/lib/pilot-invite/origin.server";

export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
  const url = new URL(request.url);
  const base = appOrigin(request);
  const { html } = renderPilotEmail({
    firstName: url.searchParams.get("first_name") ?? "",
    storeName: url.searchParams.get("store_name") ?? "",
    baseUrl: base,
    unsubscribeUrl: `${base}/pilot/unsubscribe`, // preview: untokened placeholder
  });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
