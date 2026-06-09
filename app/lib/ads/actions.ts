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
  /**
   * Whether the failure is worth retrying. Defaults to `true` (transient):
   * a permanent error simply exhausts the attempt cap and then terminally
   * fails — safe — whereas mis-classifying a transient blip as permanent
   * loses the recovery entirely. Adapters set `false` for known-permanent
   * failures (bad params, revoked token) to fail fast.
   */
  readonly retriable: boolean;
  constructor(platform: Platform, message: string, opts?: { retriable?: boolean }) {
    super(`[${platform}] ${message}`);
    this.name = "ActionError";
    this.platform = platform;
    this.retriable = opts?.retriable ?? true;
  }
}

/**
 * Default-transient classification used by the executor and the retry drain
 * (rule 5: deterministic, not the model's job). Only an `ActionError`
 * explicitly flagged `retriable: false` is terminal; every other failure is
 * treated as retriable.
 */
export function isRetriableFailure(err: unknown): boolean {
  if (err instanceof ActionError) return err.retriable;
  return true;
}

export interface ActionAdapter {
  readonly platform: Platform;
  pause(externalId: string): Promise<void>;
  resume(externalId: string): Promise<void>;
  setDailyBudget(externalId: string, cents: number): Promise<void>;
  getState(externalId: string): Promise<CampaignActionState>;
}
