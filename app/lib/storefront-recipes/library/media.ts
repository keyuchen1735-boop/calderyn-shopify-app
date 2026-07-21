import { recipeAttribute, type RecipeFragment } from "./fragment";
import type { StoreTemplateId } from "../../storefront-bundle/types";

const MEDIA_EXTENSIONS = { "image/webp": "webp", "video/webm": "webm", "video/mp4": "mp4" } as const;

export function storefrontRecipeMediaPath(templateId: StoreTemplateId, sha256: string, mediaType: keyof typeof MEDIA_EXTENSIONS): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Recipe media requires a lowercase SHA-256 hash");
  return `storefront-recipe-assets/${templateId}/${sha256}.${MEDIA_EXTENSIONS[mediaType]}`;
}

export function videoFragment(options: {
  className: string;
  posterAssetKey: string;
  webmAssetKey: string;
  mp4AssetKey: string;
  preload?: "none" | "metadata" | "auto";
}): RecipeFragment {
  const className = recipeAttribute(options.className);
  const poster = recipeAttribute(options.posterAssetKey);
  const webm = recipeAttribute(options.webmAssetKey);
  const mp4 = recipeAttribute(options.mp4AssetKey);
  return {
    html: `<video class="${className}" data-cd-video data-cd-poster-asset="${poster}" muted autoplay playsinline loop preload="${options.preload ?? "metadata"}"><source data-cd-asset="${webm}" type="video/webm"><source data-cd-asset="${mp4}" type="video/mp4"></video>`,
    css: "",
  };
}
