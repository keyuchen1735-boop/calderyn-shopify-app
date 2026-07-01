import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { listProducts, createProduct } from "~/lib/catalog/catalog.server";
import { signMediaPaths } from "~/lib/catalog/sign-media.server";
import { validateProductInput } from "~/lib/catalog/validate";
import type { ProductStatus } from "~/lib/catalog/types";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  return dashboardJson(async () => {
    const { products, total } = await listProducts(session.shopId, {
      search: url.searchParams.get("search") ?? undefined,
      status: (["draft", "active", "archived"] as ProductStatus[]).includes(status as ProductStatus) ? (status as ProductStatus) : undefined,
      offset: Number(url.searchParams.get("offset") ?? 0) || 0,
    });
    // Private bucket -> mint a signed URL for each product's primary image.
    const signed = await signMediaPaths(
      products.map((p) => p.primaryImagePath).filter((p): p is string => Boolean(p)),
    );
    return {
      total,
      products: products.map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
        variantCount: p.variantCount,
        updatedAt: p.updatedAt,
        imageUrl: p.primaryImagePath ? signed.get(p.primaryImagePath) ?? null : null,
      })),
    };
  });
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  let body: unknown;
  try { body = await request.json(); } catch { return jsonError(422, "invalid_json"); }
  const v = validateProductInput(body);
  if (!v.ok) return jsonError(422, v.code);
  return dashboardJson(() => createProduct(session.shopId, v.value));
}
