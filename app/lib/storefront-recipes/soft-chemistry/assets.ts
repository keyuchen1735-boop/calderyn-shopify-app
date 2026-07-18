import type { AssetManifest } from "../../storefront-bundle/types";

export const SOFT_CHEMISTRY_ASSETS = {
  entries: [
    {
      key: "hero",
      contentHash: "4639c3cfe144d901162c2ede0053cd6174e26379460e3d63a3bef64f286f482f",
      mediaType: "image/webp",
      byteSize: 40456,
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
