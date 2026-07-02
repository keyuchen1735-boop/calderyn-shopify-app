// GET /app/skus/:skuId/history — per-SKU daily on-hand trend (90-day window) for
// the inventory stock-trend sparkline. Loader-only resource route (no UI); the
// SKUs page lazy-loads it via a fetcher when the relocate modal opens.
import type { LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/response.server";
import { authenticate } from "../shopify.server";
import { calderynClient } from "~/lib/calderyn.server";
import type { CalderynError } from "~/lib/calderyn.server";
import { isUuid } from "~/lib/ids";
import type { SkuHistoryPoint } from "~/lib/types";

export type SkuHistoryPayload = {
  points: SkuHistoryPoint[];
  error: { code: string; message: string } | null;
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  // Boundary validation: skuId is a sku_dim uuid. A non-uuid can't match, so
  // short-circuit to empty rather than letting Postgres reject the cast.
  const skuId = String(params.skuId ?? "");
  if (!isUuid(skuId)) {
    return json<SkuHistoryPayload>({ points: [], error: null });
  }
  try {
    const points = await calderynClient(session.shop).skus.history(skuId, request.signal);
    return json<SkuHistoryPayload>({ points, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<SkuHistoryPayload>({
      points: [],
      error: { code: e.code ?? "ERROR", message: e.message },
    });
  }
};
