// app/routes/dashboard.designer.preview.tsx
// Sandboxed preview for the designer engine's documents. The response carries
// a no-script CSP and the studio embeds it in a sandboxed iframe, so the
// AI-edited document is inert markup in the merchant's browser.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { getSupabase } from "~/lib/supabase.server";
import { loadDesignerStoreData } from "~/lib/designer/engine.server";
import { DESIGNER_PREVIEW_CSP, renderDesignerDocument } from "~/lib/designer/render.server";

const ROUTES = new Set(["home", "collection", "product", "search", "cart"]);

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const url = new URL(request.url);
  const page = url.searchParams.get("page") ?? "home";
  if (!ROUTES.has(page)) throw new Response("unknown page", { status: 404 });

  const { data, error } = await getSupabase()
    .from("designer_documents")
    .select("route, html, css")
    .eq("shop_id", session.shopId)
    .in("route", ["base", page]);
  if (error) throw error;
  const base = data?.find((row) => row.route === "base");
  const doc = data?.find((row) => row.route === page);
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": DESIGNER_PREVIEW_CSP,
    "x-frame-options": "SAMEORIGIN",
  };
  if (!doc) {
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{margin:0;display:grid;place-items:center;min-height:100vh;font-family:system-ui;color:#6b7280;background:#fafaf9}</style></head><body><p>Tell Calderyn what to build and it appears here.</p></body></html>`,
      { headers },
    );
  }
  const storeData = await loadDesignerStoreData(session.shopId);
  const html = renderDesignerDocument({
    html: String(doc.html ?? ""),
    css: `${String(base?.css ?? "")}\n${String(doc.css ?? "")}`,
    data: storeData,
  });
  return new Response(html, { headers });
}
