import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { listInventory, attachRestockPresence } from "~/lib/catalog/inventory-list.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const url = new URL(request.url);
  const stock = url.searchParams.get("stock");
  return dashboardJson(async () => {
    const { rows, total } = await listInventory(session.shopId, {
      search: url.searchParams.get("search") ?? undefined,
      stock: stock === "low" || stock === "out" ? stock : undefined,
      offset: Number(url.searchParams.get("offset") ?? 0) || 0,
    });
    return { rows: await attachRestockPresence(session.shopId, rows), total };
  });
}
