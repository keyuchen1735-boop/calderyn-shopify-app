// Resolve the action adapter for a shop + platform. Thin dispatcher; keeps the
// executor platform-blind.

import type { Platform } from "./adapter";
import type { ActionAdapter } from "./actions";
import { metaActionAdapterForShop } from "../meta/actions.server";
import { googleActionAdapterForShop } from "../google/actions.server";
import { tiktokActionAdapterForShop } from "../tiktok/actions.server";

export function actionAdapterForShop(shopId: string, platform: Platform): Promise<ActionAdapter | null> {
  switch (platform) {
    case "meta":
      return metaActionAdapterForShop(shopId);
    case "google":
      return googleActionAdapterForShop(shopId);
    case "tiktok":
      return tiktokActionAdapterForShop(shopId);
  }
}
