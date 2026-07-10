// /dashboard/api/po/suppliers — merchant suppliers for the PO flow.
// GET → { suppliers: SupplierDto[] } (active and inactive; the UI filters).
// POST intents: "create", "update" ({supplierId, ...fields}), "set_active"
// ({supplierId, active}).

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { CalderynError } from "~/lib/calderyn.server";
import {
  createSupplier,
  listSuppliers,
  setSupplierActive,
  updateSupplier,
  validateSupplierInput,
} from "~/lib/po/suppliers.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({ suppliers: await listSuppliers(session.shopId) }));
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }

  return dashboardJson(async () => {
    if (body.intent === "create") {
      return { supplier: await createSupplier(session.shopId, validateSupplierInput(body)) };
    }
    const supplierId = typeof body.supplierId === "string" ? body.supplierId : "";
    if (!supplierId) {
      throw new CalderynError({
        code: "invalid_supplier",
        status: 422,
        message: "Missing supplier reference.",
      });
    }
    if (body.intent === "update") {
      return {
        supplier: await updateSupplier(session.shopId, supplierId, validateSupplierInput(body)),
      };
    }
    if (body.intent === "set_active") {
      return {
        supplier: await setSupplierActive(session.shopId, supplierId, body.active === true),
      };
    }
    throw new CalderynError({ code: "invalid_intent", status: 422, message: "Unknown intent." });
  });
}
