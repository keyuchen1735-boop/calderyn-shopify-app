// app/routes/[robots.txt].tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { buildRobotsTxt } from "~/lib/seo/site-files.server";
import { storefrontOrigin } from "~/lib/seo/origin.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const body = buildRobotsTxt(storefrontOrigin(request));
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
