// app/lib/storegen/imagery/provider.ts
// The single imagery seam (design "single imagery-source seam"). Everything that needs a
// generated listing image goes through ImageProvider, so blocks/editor/storefront never care
// about the backend. Higgsfield is the default impl; Bloom can swap in later behind this.
export interface ListingImageRequest {
  productTitle: string;
  productDescription: string;
  sourceImageUrl: string | null;
  mode: "product_shot" | "lifestyle_scene";
}
export interface ImageProvider {
  name: string;
  generateListingImage(req: ListingImageRequest): Promise<{ url: string }>;
}

import { higgsfieldProvider } from "./higgsfield.server";

export function getImageProvider(): ImageProvider {
  // ponytail: single provider for now; env hook lets a Bloom impl slot in without call-site churn.
  return higgsfieldProvider;
}
