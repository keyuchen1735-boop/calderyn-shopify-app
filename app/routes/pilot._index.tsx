// app/routes/pilot._index.tsx
import type { LoaderFunctionArgs } from "react-router";
import { renderPilotLanding } from "~/lib/pilot-invite/landing.server";
import { appOrigin } from "~/lib/pilot-invite/origin.server";

export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
  const url = new URL(request.url);
  const html = renderPilotLanding({
    firstName: url.searchParams.get("first_name") ?? "",
    storeName: url.searchParams.get("store_name") ?? "",
    baseUrl: appOrigin(request),
  });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
