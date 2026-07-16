import { mapWithConcurrency } from "~/lib/ads/concurrency";
import { getSupabase } from "~/lib/supabase.server";
import { getImageProvider } from "~/lib/storegen/imagery/provider.server";
import { persistExternalImage } from "./persist.server";

const DEFAULT_LIMIT = 10;
const CONCURRENCY = 5;
const SOURCE = "gemini";

interface Claim {
  shop_id: string;
  product_id: string;
  title?: string;
  description?: string;
  attempt_count?: number;
  lease_expires_at?: string;
}

interface StatePatch {
  status: "ready" | "failed";
  url: string | null;
  next_attempt_at: string | null;
  lease_expires_at: null;
}

interface Dependencies {
  rpc(limit: number): Promise<{ data: Claim[] | null; error: unknown }>;
  generate(claim: Claim): Promise<{ url: string }>;
  update(claim: Claim, patch: StatePatch): Promise<{ error: unknown }>;
  now?: () => Date;
}

function dependencies(): Dependencies {
  const sb = getSupabase();
  return {
    rpc: async (limit) => sb.rpc("claim_missing_storefront_images", { p_limit: limit }),
    async generate(claim) {
      const generated = await getImageProvider().generateListingImage({
        shopId: claim.shop_id,
        productTitle: claim.title ?? "Product",
        productDescription: claim.description ?? "",
        sourceImageUrl: null,
        mode: "product_shot",
        purpose: "storefront_product",
      });
      const persisted = await persistExternalImage(
        claim.shop_id,
        generated.url,
        "generated",
        "generated",
      );
      if (!persisted.persisted) throw new Error(`generated image persistence failed: ${persisted.error}`);
      return { url: persisted.url };
    },
    async update(claim, patch) {
      const query = sb
        .from("store_asset")
        .update(patch)
        .eq("shop_id", claim.shop_id)
        .eq("product_id", claim.product_id)
        .eq("source", SOURCE);
      return claim.lease_expires_at
        ? query.eq("lease_expires_at", claim.lease_expires_at)
        : query;
    },
  };
}

function backoffAt(now: Date, attemptCount = 1): string {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 9));
  const minutes = Math.min(5 * 2 ** exponent, 24 * 60);
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

function throwError(error: unknown): void {
  if (!error) return;
  if (error instanceof Error) throw error;
  if (typeof error === "object" && "message" in error) throw new Error(String(error.message));
  throw new Error(String(error));
}

export async function generateMissingProductImages(
  limit = DEFAULT_LIMIT,
  deps: Dependencies = dependencies(),
): Promise<{ claimed: number; ready: number; failed: number }> {
  const claimResult = await deps.rpc(limit);
  throwError(claimResult.error);
  const claims = claimResult.data ?? [];
  let ready = 0;
  let failed = 0;

  const outcomes = await mapWithConcurrency(claims, CONCURRENCY, async (claim) => {
    let generated: { url: string };
    try {
      generated = await deps.generate(claim);
    } catch {
      const result = await deps.update(claim, {
        status: "failed",
        url: null,
        next_attempt_at: backoffAt(deps.now?.() ?? new Date(), claim.attempt_count),
        lease_expires_at: null,
      });
      throwError(result.error);
      return "failed" as const;
    }

    const result = await deps.update(claim, {
      status: "ready",
      url: generated.url,
      next_attempt_at: null,
      lease_expires_at: null,
    });
    throwError(result.error);
    return "ready" as const;
  });

  for (const outcome of outcomes) {
    if (!outcome.ok) throwError(outcome.error);
    else if (outcome.value === "ready") ready++;
    else failed++;
  }
  return { claimed: claims.length, ready, failed };
}
