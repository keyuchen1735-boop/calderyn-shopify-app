import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import {
  dashboardJson,
  jsonError,
  requireSameOrigin,
} from "~/lib/dashboard/http.server";
import { listProducts, createProduct } from "~/lib/catalog/catalog.server";
import { signMediaPaths } from "~/lib/catalog/sign-media.server";
import { validateProductInput } from "~/lib/catalog/validate";
import { isCatalogSort } from "~/lib/catalog/catalog-sort";
import type { ProductStatus } from "~/lib/catalog/types";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const sort = url.searchParams.get("sort") ?? "";
  // Date-range bounds pass through only when they parse as real datetimes — a
  // malformed value degrades to "no bound", never a PostgREST 500.
  const isoParam = (name: string): string | undefined => {
    const raw = url.searchParams.get(name);
    return raw && Number.isFinite(Date.parse(raw)) ? raw : undefined;
  };
  return dashboardJson(async () => {
    const { products, total } = await listProducts(session.shopId, {
      search: url.searchParams.get("search") ?? undefined,
      status: (["draft", "active", "archived"] as ProductStatus[]).includes(
        status as ProductStatus,
      )
        ? (status as ProductStatus)
        : undefined,
      offset: Number(url.searchParams.get("offset") ?? 0) || 0,
      sort: isCatalogSort(sort) ? sort : undefined,
      updatedFrom: isoParam("updated_from"),
      updatedTo: isoParam("updated_to"),
    });
    // Private bucket -> mint a signed URL for each product's primary image.
    const signed = await signMediaPaths(
      products
        .map((p) => p.primaryImagePath)
        .filter((p): p is string => Boolean(p)),
    );
    return {
      total,
      products: products.map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
        variantCount: p.variantCount,
        updatedAt: p.updatedAt,
        imageUrl: p.primaryImagePath
          ? (signed.get(p.primaryImagePath) ?? null)
          : p.primaryImageUrl,
        priceCents: p.priceCents,
        shipDataOk: p.shipDataOk,
        shipWeightGrams: p.shipWeightGrams,
      })),
    };
  });
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(422, "invalid_json");
  }
  const v = validateProductInput(body);
  if (!v.ok) return jsonError(422, v.code);
  return dashboardJson(() => createProduct(session.shopId, v.value));
}
