import type { AssetManifest } from "~/lib/storefront-bundle/types";
import type { RecipeMediaArtifacts } from "../factory";

export const LARDER_VIDEO_ROLES = ["hero", "hero-alt", "pdp-detail"] as const;

export const LARDER_VIDEO_ASSET_KEYS = LARDER_VIDEO_ROLES.flatMap((role) => [
  `${role}-poster`,
  `${role}-webm`,
  `${role}-mp4`,
]);

export const LARDER_ASSETS: AssetManifest = {
  entries: [
    { key: "hero-poster", contentHash: "897e50afb2d13ca6360617d7fddc290b338dea0bef50efb45c09d062533538ca", mediaType: "image/webp", byteSize: 38062 },
    { key: "hero-webm", contentHash: "c8ccdb9db901035e22d8d9666b416fdd8d5a48cdd8f6dacfcd215dc261f5ddcc", mediaType: "video/webm", byteSize: 1028352 },
    { key: "hero-mp4", contentHash: "19d9eab682f160cfc4258a7c0f175237d4933d2322073252a03b601e34efcb57", mediaType: "video/mp4", byteSize: 1259511 },
    { key: "hero-alt-poster", contentHash: "6df6e44cf0233a921d6ad89e3692b1cff63f2892157337649247a3b12031400c", mediaType: "image/webp", byteSize: 68210 },
    { key: "hero-alt-webm", contentHash: "90e0ad72d3367c1ee2a8d04be5d2f53b91b876c0e3d490b64ddc000430c74e3b", mediaType: "video/webm", byteSize: 933935 },
    { key: "hero-alt-mp4", contentHash: "cf440e3a73f73847bc9286ea1d2c5fa45adce65fa04aba1b0fb9107a16563f15", mediaType: "video/mp4", byteSize: 1204368 },
    { key: "pdp-detail-poster", contentHash: "377309f32e885bd3edd285298012c1729e3b19decd018dfe0ece385ec515314d", mediaType: "image/webp", byteSize: 67722 },
    { key: "pdp-detail-webm", contentHash: "61918da9e50badc5b451d4f1798eb25a02d12e4a6315588031f96154c9d69be6", mediaType: "video/webm", byteSize: 1463232 },
    { key: "pdp-detail-mp4", contentHash: "bc7d8ddd9617226abd296a809d8bec28f0d5eb87a2267e0f8076975dfd566bed", mediaType: "video/mp4", byteSize: 1768622 },
  ],
};

const records: RecipeMediaArtifacts["manifest"]["records"] = [
  {
    templateId: "larder", role: "hero", masterHash: "99d7231ad6a3dac1e31fde02577e03ff15112820ae58dac7092bfe7c043aba54", duration: 8, width: 1280, height: 720,
    entries: [
      { contentHash: "897e50afb2d13ca6360617d7fddc290b338dea0bef50efb45c09d062533538ca", mediaType: "image/webp", byteSize: 38062, objectPath: "storefront-recipe-assets/larder/897e50afb2d13ca6360617d7fddc290b338dea0bef50efb45c09d062533538ca.webp" },
      { contentHash: "c8ccdb9db901035e22d8d9666b416fdd8d5a48cdd8f6dacfcd215dc261f5ddcc", mediaType: "video/webm", byteSize: 1028352, objectPath: "storefront-recipe-assets/larder/c8ccdb9db901035e22d8d9666b416fdd8d5a48cdd8f6dacfcd215dc261f5ddcc.webm" },
      { contentHash: "19d9eab682f160cfc4258a7c0f175237d4933d2322073252a03b601e34efcb57", mediaType: "video/mp4", byteSize: 1259511, objectPath: "storefront-recipe-assets/larder/19d9eab682f160cfc4258a7c0f175237d4933d2322073252a03b601e34efcb57.mp4" },
    ],
  },
  {
    templateId: "larder", role: "hero-alt", masterHash: "b7f6fd87590337bffb1e48c6cb1cdb64698e690214cc80b535d94c58727e3f79", duration: 8, width: 1280, height: 720,
    entries: [
      { contentHash: "6df6e44cf0233a921d6ad89e3692b1cff63f2892157337649247a3b12031400c", mediaType: "image/webp", byteSize: 68210, objectPath: "storefront-recipe-assets/larder/6df6e44cf0233a921d6ad89e3692b1cff63f2892157337649247a3b12031400c.webp" },
      { contentHash: "90e0ad72d3367c1ee2a8d04be5d2f53b91b876c0e3d490b64ddc000430c74e3b", mediaType: "video/webm", byteSize: 933935, objectPath: "storefront-recipe-assets/larder/90e0ad72d3367c1ee2a8d04be5d2f53b91b876c0e3d490b64ddc000430c74e3b.webm" },
      { contentHash: "cf440e3a73f73847bc9286ea1d2c5fa45adce65fa04aba1b0fb9107a16563f15", mediaType: "video/mp4", byteSize: 1204368, objectPath: "storefront-recipe-assets/larder/cf440e3a73f73847bc9286ea1d2c5fa45adce65fa04aba1b0fb9107a16563f15.mp4" },
    ],
  },
  {
    templateId: "larder", role: "pdp-detail", masterHash: "15f2daa75e2b8cd622bddec7a16473f1802f4f71b438716b4487052388d8ce64", duration: 8, width: 1280, height: 720,
    entries: [
      { contentHash: "377309f32e885bd3edd285298012c1729e3b19decd018dfe0ece385ec515314d", mediaType: "image/webp", byteSize: 67722, objectPath: "storefront-recipe-assets/larder/377309f32e885bd3edd285298012c1729e3b19decd018dfe0ece385ec515314d.webp" },
      { contentHash: "61918da9e50badc5b451d4f1798eb25a02d12e4a6315588031f96154c9d69be6", mediaType: "video/webm", byteSize: 1463232, objectPath: "storefront-recipe-assets/larder/61918da9e50badc5b451d4f1798eb25a02d12e4a6315588031f96154c9d69be6.webm" },
      { contentHash: "bc7d8ddd9617226abd296a809d8bec28f0d5eb87a2267e0f8076975dfd566bed", mediaType: "video/mp4", byteSize: 1768622, objectPath: "storefront-recipe-assets/larder/bc7d8ddd9617226abd296a809d8bec28f0d5eb87a2267e0f8076975dfd566bed.mp4" },
    ],
  },
];

export const LARDER_MEDIA_ARTIFACTS: RecipeMediaArtifacts = {
  manifest: { templateId: "larder", records },
  proof: {
    records: records.map(({ templateId, role, masterHash }) => ({
      templateId,
      role,
      masterHash,
      technicalApproval: { approved: true, masterHash },
      visualApproval: { approved: true, scope: "full-loop" },
    })),
  },
};
