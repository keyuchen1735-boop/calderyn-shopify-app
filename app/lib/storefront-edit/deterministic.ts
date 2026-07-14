import type { StorefrontBundleV1 } from "../storefront-bundle/types";
import { applyStorefrontPatch } from "./patch.server";
import type { StorefrontPatchOperation } from "./types";

/** Kept separate so callers can prove deterministic edits make zero provider calls. */
export function applyDeterministicStorefrontEdit(bundle: StorefrontBundleV1, operations: StorefrontPatchOperation[]) {
  return applyStorefrontPatch(bundle, operations);
}
