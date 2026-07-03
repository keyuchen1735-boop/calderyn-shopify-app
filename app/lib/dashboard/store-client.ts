// Client fetchers for the Store studio surface. Kept in its own module (not
// client.ts) so parallel surface work never collides on one file.
import { apiGet, apiSend } from "./client";
import type {
  StudioState,
  StudioSettings,
  StudioHero,
  StudioProduct,
  StudioGeneration,
  StudioGenerationStatus,
  StudioGenerateReceipt,
} from "~/lib/storebuilder/studio-types";

export type {
  StudioState,
  StudioSettings,
  StudioHero,
  StudioProduct,
  StudioGeneration,
  StudioGenerationStatus,
  StudioGenerateReceipt,
};

export async function fetchStudio(): Promise<StudioState> {
  return apiGet<StudioState>("/dashboard/api/store");
}

/** Persist the home hero copy (headline + subhead) into the draft doc. */
export async function saveStudioHero(hero: StudioHero): Promise<StudioHero> {
  const data = await apiSend<{ hero: StudioHero }>("POST", "/dashboard/api/store", {
    action: "save-hero",
    headline: hero.headline,
    subhead: hero.subhead,
  });
  return data.hero;
}

/** Set the brand palette's primary/accent color (#rrggbb). */
export async function setStudioAccent(color: string): Promise<string> {
  const data = await apiSend<{ accent: string }>("POST", "/dashboard/api/store", {
    action: "accent",
    color,
  });
  return data.accent;
}

/** Kick off a real store generation. An empty brief generates from the catalog
 *  alone. Awaits the full run — this can take several seconds. */
export async function generateStudioStore(brief: string): Promise<StudioGenerateReceipt> {
  return apiSend<StudioGenerateReceipt>("POST", "/dashboard/api/store", {
    action: "generate",
    brief,
  });
}

/** Publish every drafted storefront page. 409s when there is no draft. */
export async function publishStudioStore(): Promise<{ publishedAt: string }> {
  return apiSend<{ publishedAt: string }>("POST", "/dashboard/api/store", {
    action: "publish",
  });
}
