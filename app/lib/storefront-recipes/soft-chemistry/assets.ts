import type { AssetManifest } from "../../storefront-bundle/types";

export const SOFT_CHEMISTRY_ASSETS = {
  entries: [
    {
      key: "hero",
      contentHash: "3e4065d68a9fd398f6d9d0ee492ee3ad099d7b7f31f669d822a07504b1f584e8",
      mediaType: "image/webp",
      byteSize: 184188,
    },
    {
      key: "collection",
      contentHash: "5c59a7d1ea9703d6f14e31f9e0ccaa0cee371c9821c3611a4c892bbbdf98b56a",
      mediaType: "image/webp",
      byteSize: 294302,
    },
    {
      key: "texture",
      contentHash: "613d1fac6df5eb13b7c60922ca06b34f93600cac43146c8286d702c55ad48561",
      mediaType: "image/webp",
      byteSize: 34232,
    },
  ],
} satisfies AssetManifest;
