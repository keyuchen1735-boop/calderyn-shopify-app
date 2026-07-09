// The single catalog of everything the assistant can DO. Domain files each
// export an AssistantAction[]; add new capabilities there, never inline in
// the dispatcher. Tier-3 operations (delete account, demo reset, cutover,
// auth/session) are excluded by construction — they must never appear here.
import type Anthropic from "@anthropic-ai/sdk";
import type { AssistantAction } from "./registry-types";
// Domain imports are added by Tasks 4–7:
// import { CAMPAIGN_ACTIONS } from "./campaign-actions.server";
// import { CATALOG_ACTIONS } from "./catalog-actions.server";
// import { INVENTORY_ACTIONS } from "./inventory-actions.server";
// import { OPS_ACTIONS } from "./ops-actions.server";

export const ASSISTANT_ACTIONS: AssistantAction[] = [
  // ...CAMPAIGN_ACTIONS, ...CATALOG_ACTIONS, ...INVENTORY_ACTIONS, ...OPS_ACTIONS,
];

export function actionByName(name: string): AssistantAction | undefined {
  return ASSISTANT_ACTIONS.find((a) => a.name === name);
}

export function generatedWriteTools(): Anthropic.Tool[] {
  return ASSISTANT_ACTIONS.map((a) => ({
    name: a.name,
    description:
      a.tier === "confirm"
        ? `${a.description} REQUIRES MERCHANT CONFIRMATION: calling this shows a confirm card; it does not execute until the merchant taps Confirm.`
        : a.description,
    input_schema: a.inputSchema,
  }));
}
