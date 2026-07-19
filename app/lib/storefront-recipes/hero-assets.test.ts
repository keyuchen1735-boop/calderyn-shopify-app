import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STOREFRONT_RECIPES } from ".";

const EXPECTED_HERO_HASHES: Readonly<Record<string, string>> = {
  "atelier-nine": "bf43ff158ad36f2399f116949983f821578bec4e4bbf7baad34791604ac90fc9",
  "broadcast-patch-bay": "69ccaff50a8fd6fed877c3b442b477a77bd2437fa803593e4b9cd0cc46fcea2d",
  "commons-index": "ff556322c3b5d79a5c1ba330eab531a24b576c0a881b231def9e63fa65d3660d",
  "companion-field-guide": "781d85b12f429b4de18501fd21e0c778006b95f22f671766719d15b592a9bbe6",
  "custom-bench": "4057747b344149325da07a76b2ac90cdf5f820a9c8f0f649d635daf9ff3cf5c1",
  "daily-protocol": "8a1a4532e0055e3e560044a035e80990a49d0db9b2a942ecdc88fd2ccec9403e",
  "diagnostic-deck": "3ec4b7089816ee8f7f3355667558a7e4b3c71ec7166150d8d4570236cdbef58e",
  "rep-rest": "ba5abf2b75b5327574e7fa788b6be80ac2f847dfd560d00c1cf892104208ddcf",
  "ritual-almanac": "17eb9713bfc652eb445769c84f886ef591e26d3e8171728c20f32aa26612e8a0",
  "room-modes": "15b65243fb73023d2af89bc2db8146c4f0f8f0fa5b3fd6db2917c44e15a083d0",
  "soft-chemistry": "3e4065d68a9fd398f6d9d0ee492ee3ad099d7b7f31f669d822a07504b1f584e8",
};

const LEGACY_HERO_HASHES: Readonly<Record<string, string>> = {
  "broadcast-patch-bay": "c95d86839d3b7efea39f439452011aaad78e4519e9928890246f67b0bf9f5363",
  "commons-index": "9201028ef1da24dd4318d0dafd8b4e18f32d16e12ba921c5ded28765b0cbaca1",
  "companion-field-guide": "305b7c4a9f43578032dba1e95a63869d9e17b370585c24438b7b963aa0a9a2d6",
  "custom-bench": "f6f25c15de46bf6dd431ae685202f90fbbc3ba00e8051f6a6f4afaa8b89cdde9",
  "daily-protocol": "798fb222ba0b6975c3f83d7d95f6640227f781b2e4582f758cc712a0f45a8054",
  "diagnostic-deck": "dca1f96a14f60dcc2b1305f84ac97b480f8007a25709ac9995eee71ac8e2db9e",
  "rep-rest": "b404cf72b60022837096e1e8b02d539b5369a9ff09d4bda742378b7aae71d9c1",
  "ritual-almanac": "747c24090ce37d341af9d22a7057f5830c26dc74181da0d82bb5aa07ffafe8f8",
  "room-modes": "ed779ae096effacc6af8a58f5ab55b79faad5ae2b3b5fba892b796e310586d30",
  "soft-chemistry": "4639c3cfe144d901162c2ede0053cd6174e26379460e3d63a3bef64f286f482f",
};

describe("storefront recipe hero assets", () => {
  it("keeps every template tied to its approved hero image", () => {
    for (const recipe of STOREFRONT_RECIPES) {
      const templateId = recipe.config.templateId;
      const bytes = readFileSync(`public/storefront-recipes/${templateId}/hero.webp`);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const manifestHero = recipe.config.assets.entries.find(({ key }) => key === "hero");

      expect(hash, templateId).toBe(EXPECTED_HERO_HASHES[templateId]);
      expect(manifestHero?.contentHash, templateId).toBe(hash);
      expect(manifestHero?.byteSize, templateId).toBe(bytes.byteLength);
      expect(readFileSync(`public/storefront-recipes/${templateId}/${hash}.webp`), templateId).toEqual(bytes);
    }
  }, 15_000);

  it("retains content-addressed hero bytes for published recipe versions", () => {
    for (const [templateId, hash] of Object.entries(LEGACY_HERO_HASHES)) {
      const bytes = readFileSync(`public/storefront-recipes/${templateId}/${hash}.webp`);

      expect(createHash("sha256").update(bytes).digest("hex"), templateId).toBe(hash);
    }
  });
});
