// app/lib/storegen/imagery/provider.server.ts
// The single imagery seam (design "single imagery-source seam"). Everything that needs a
// generated listing image goes through ImageProvider, so blocks/editor/storefront never care
// about the backend. Higgsfield is the default impl; Bloom can swap in later behind this.
import { higgsfieldProvider } from "./higgsfield.server";

export interface ListingImageRequest {
  productTitle: string;
  productDescription: string;
  sourceImageUrl: string | null;
  mode: "product_shot" | "lifestyle_scene";
  signal?: AbortSignal;
}
export interface ImageProvider {
  name: string;
  generateListingImage(req: ListingImageRequest): Promise<{ url: string }>;
}

export function getImageProvider(): ImageProvider {
  // ponytail: single provider for now; a Bloom impl swaps in by replacing this module.
  return higgsfieldProvider;
}
