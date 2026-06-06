// Platform-blind campaign action contract. One implementation per platform; the
// executor (app/lib/actions/execute.server.ts) dispatches to it without knowing
// which platform it is.

import type { Platform } from "./adapter";

export type { Platform };

export interface CampaignActionState {
  status: "active" | "paused";
  dailyBudgetCents: number | null;
}

/** Thrown by adapters on a platform API failure (surfaced into action_audit). */
export class ActionError extends Error {
  readonly platform: Platform;
  constructor(platform: Platform, message: string) {
    super(`[${platform}] ${message}`);
    this.name = "ActionError";
    this.platform = platform;
  }
}

export interface ActionAdapter {
  readonly platform: Platform;
  pause(externalId: string): Promise<void>;
  resume(externalId: string): Promise<void>;
  setDailyBudget(externalId: string, cents: number): Promise<void>;
  getState(externalId: string): Promise<CampaignActionState>;
}
