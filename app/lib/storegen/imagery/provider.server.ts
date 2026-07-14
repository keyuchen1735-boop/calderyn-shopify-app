// app/lib/storegen/imagery/provider.server.ts
// The single imagery seam (design "single imagery-source seam"). Everything that needs a
// generated listing image goes through ImageProvider, so blocks/editor/storefront never care
// about the backend.
import { generateGeminiImages } from "./gemini.server";

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
  return {
    name: "gemini",
    async generateListingImage(req) {
      const [url] = await generateGeminiImages({
        prompt: `Create a clean ecommerce ${req.mode === "product_shot" ? "product photo" : "lifestyle image"} for ${req.productTitle}. ${req.productDescription}`,
        referenceImageUrl: req.sourceImageUrl,
        signal: req.signal,
      });
      return { url };
    },
  };
}
