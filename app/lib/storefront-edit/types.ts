import type { CuratedFontId, StorefrontRouteId } from "../storefront-bundle/types";

export interface StorefrontRegionSource {
  html: string;
  css: string;
}

export type StorefrontPatchOperation =
  | { kind: "setToken"; tokenId: string; value: string; expected?: string }
  | { kind: "setFont"; target: "display" | "body"; fontId: CuratedFontId; expected?: CuratedFontId }
  | { kind: "setText" | "replaceTextChildren"; routeId: StorefrontRouteId; targetId: string; value: string; expected?: string }
  | { kind: "setVisibility"; routeId: StorefrontRouteId; targetId: string; hidden: boolean; expected?: string }
  | { kind: "moveRegion"; routeId: StorefrontRouteId; targetId: string; direction: "up" | "down" }
  | { kind: "reorderChildren"; routeId: StorefrontRouteId; parentId: string; childIds: string[]; expected?: string[] }
  | {
      kind: "replaceRegion";
      routeId: Exclude<StorefrontRouteId, "checkout">;
      targetId: string;
      expected: string;
      source: StorefrontRegionSource;
    }
  | {
      kind: "replaceRouteCss";
      routeId: Exclude<StorefrontRouteId, "checkout">;
      expected: string;
      css: string;
    };
