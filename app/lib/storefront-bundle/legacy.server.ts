import { isUuid } from "~/lib/ids";
import { getSupabase } from "~/lib/supabase.server";
import { StorefrontReleaseError } from "./release.server";

export interface CaptureLegacyReleaseInput {
  shopId: string;
  actorId?: string | null;
}

/** The database captures documents/settings under one row lock and returns the existing capture on retries. */
export async function captureLegacyRelease(input: CaptureLegacyReleaseInput): Promise<string> {
  if (!isUuid(input.shopId)) throw new StorefrontReleaseError("invalid_storefront_release", "shopId must be a UUID", 422);
  const { data, error } = await getSupabase().rpc("capture_storefront_legacy_release", {
    p_shop_id: input.shopId,
    p_actor_id: input.actorId ?? null,
  });
  if (error) throw new StorefrontReleaseError("legacy_capture_failed", error.message, 500, error);
  if (!isUuid(data as string)) throw new StorefrontReleaseError("legacy_capture_failed", "Legacy capture returned no version id", 500);
  return data as string;
}
