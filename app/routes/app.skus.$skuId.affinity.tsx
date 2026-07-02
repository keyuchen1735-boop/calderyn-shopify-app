// GET /app/skus/:skuId/affinity — "frequently bought with" for one SKU (top
// co-purchased SKUs, trailing 90 days). Loader-only resource route; the SKUs
// page lazy-loads it via a fetcher when the relocate modal opens.
import type { LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/response.server";
import { authenticate } from "../shopify.server";
import { calderynClient } from "~/lib/calderyn.server";
import type { CalderynError } from "~/lib/calderyn.server";
import { isUuid } from "~/lib/ids";
import type { SkuAffinityItem } from "~/lib/types";

export type SkuAffinityPayload = {
  items: SkuAffinityItem[];
  error: { code: string; message: string } | null;
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  // Boundary validation: a non-uuid skuId can't match — short-circuit to empty.
  const skuId = String(params.skuId ?? "");
  if (!isUuid(skuId)) {
    return json<SkuAffinityPayload>({ items: [], error: null });
  }
  try {
    const items = await calderynClient(session.shop).skus.affinity(skuId, request.signal);
    return json<SkuAffinityPayload>({ items, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<SkuAffinityPayload>({
      items: [],
      error: { code: e.code ?? "ERROR", message: e.message },
    });
  }
};
