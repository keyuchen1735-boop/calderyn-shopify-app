// app/lib/storegen/imagery/higgsfield.server.ts
// Higgsfield impl of ImageProvider. Generation is async + credit-metered; the caller
// (asset.server.ts) owns budgeting and the source-image fallback, so this just performs one
// generation and returns the URL (or throws, which the caller catches → keeps the source image).
import type { ImageProvider, ListingImageRequest } from "./provider.server";

async function generate(req: ListingImageRequest): Promise<{ url: string }> {
  // ponytail: wraps the Higgsfield product-photoshoot path. The concrete CLI/SDK call is wired
  // at implementation time against the higgsfield-product-photoshoot tooling; this function MUST
  // return { url } of a generated image or throw. Keep it to one generation per call.
  const { runHiggsfieldProductPhotoshoot } = await import("./higgsfield-client.server");
  const url = await runHiggsfieldProductPhotoshoot({
    mode: req.mode,
    title: req.productTitle,
    description: req.productDescription,
    referenceImageUrl: req.sourceImageUrl,
  });
  return { url };
}

export const higgsfieldProvider: ImageProvider = { name: "higgsfield", generateListingImage: generate };
