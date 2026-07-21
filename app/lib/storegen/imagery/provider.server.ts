// app/lib/storegen/imagery/provider.server.ts
// The single imagery seam (design "single imagery-source seam"). Everything that needs a
// generated listing image goes through ImageProvider, so blocks/editor/storefront never care
// about the backend.
import { generateGeminiImages } from "./gemini.server";
import type { ImageGenLimits } from "~/lib/screener/image-gen-limit.server";

export interface ListingImageRequest {
  shopId: string;
  productTitle: string;
  productDescription: string;
  sourceImageUrl: string | null;
  mode: "product_shot" | "lifestyle_scene";
  purpose?: "storefront_product" | "storefront_design";
  signal?: AbortSignal;
  /** Per-reservation daily-cap override (designer first-build reserve). */
  limits?: Partial<ImageGenLimits>;
}
export interface ImageProvider {
  name: string;
  generateListingImage(req: ListingImageRequest): Promise<{ url: string }>;
}

export function getImageProvider(): ImageProvider {
  return {
    name: "gemini",
    async generateListingImage(req) {
      const [url] = await generateGeminiImages({
        shopId: req.shopId,
        purpose: req.purpose ?? "storefront_product",
        prompt: `Create a clean ecommerce ${req.mode === "product_shot" ? "product photo" : "lifestyle image"} for ${req.productTitle}. ${req.productDescription}`,
        referenceImageUrl: req.sourceImageUrl,
        signal: req.signal,
        limits: req.limits,
      });
      return { url };
    },
  };
}
