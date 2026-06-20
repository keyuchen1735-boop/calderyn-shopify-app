// Resolve the action adapter for a shop + platform. Thin dispatcher; keeps the
// executor platform-blind.

import type { Platform } from "./adapter";
import type { ActionAdapter } from "./actions";
import { metaActionAdapterForShop } from "../meta/actions.server";
import { googleActionAdapterForShop } from "../google/actions.server";
import { tiktokActionAdapterForShop } from "../tiktok/actions.server";
import { isShowcaseShop, showcaseActionAdapter } from "../demo/showcase.server";

export async function actionAdapterForShop(shopId: string, platform: Platform): Promise<ActionAdapter | null> {
  // Showcase/demo store: succeed without touching the live ad platform (its
  // seeded campaigns have no real platform object). Real shops fall through to
  // the credential-backed adapters below.
  if (await isShowcaseShop(shopId)) return showcaseActionAdapter(platform);
  switch (platform) {
    case "meta":
      return metaActionAdapterForShop(shopId);
    case "google":
      return googleActionAdapterForShop(shopId);
    case "tiktok":
      return tiktokActionAdapterForShop(shopId);
  }
}
