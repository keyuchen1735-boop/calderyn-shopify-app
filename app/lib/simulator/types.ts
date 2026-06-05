// app/lib/simulator/types.ts

/** Ordered funnel a shopper walks. Index order is significant. */
export const FUNNEL_STAGES = [
  "landed",
  "viewed_product",
  "added_to_cart",
  "started_checkout",
  "shipping_reveal",
  "bought",
] as const;

export type FunnelStageId = (typeof FUNNEL_STAGES)[number];

export const FUNNEL_STAGE_LABELS: Record<FunnelStageId, string> = {
  landed: "Landed",
  viewed_product: "Viewed a product",
  added_to_cart: "Added to cart",
  started_checkout: "Started checkout",
  shipping_reveal: "Shipping reveal",
  bought: "Bought",
};

export type Severity = "critical" | "high" | "low";

/** One shopper archetype the model treats as a homogeneous sub-population. */
export interface Archetype {
  id: string; // slug, e.g. "deal-hunter"
  name: string; // display, e.g. "Deal-hunter"
  weight: number; // share of the population (0..1); normalised at sample time
  /** advance[stage] = P(moving from `stage` to the NEXT stage). `bought` is terminal. */
  advance: Record<FunnelStageId, number>;
  /** Why this archetype bounces at a given stage (shown in the persona table). */
  dropReason: Partial<Record<FunnelStageId, string>>;
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string; // "Shipping cost shock"
  stage: FunnelStageId; // where it bites
  personaIds: string[]; // archetype ids most affected
  fix: string; // one-line suggested fix
}

export interface BehaviorModel {
  storeSummary: string; // Claude's one-line read of the store
  shipping: { amount: number; currency: string; estimated: boolean };
  archetypes: Archetype[];
  findings: Finding[];
}

/** Real page content handed to Claude. */
export interface StoreSnapshot {
  shop: string;
  homeText: string;
  product: {
    title: string;
    descriptionText: string;
    priceText: string;
    url: string;
  } | null;
  shipping: { amount: number; currency: string; estimated: boolean };
}

export type RunStatus = "queued" | "running" | "done" | "error";

/** DTO shape returned to the client — never the raw DB row. */
export interface SimulationRun {
  id: string;
  status: RunStatus;
  target: string;
  requestedN: number;
  model: BehaviorModel | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface StageCount {
  id: FunnelStageId;
  label: string;
  reached: number;
}

export interface SampleResult {
  n: number;
  stages: StageCount[];
  bought: number;
  biggestLeak: { stageId: FunnelStageId; label: string; count: number } | null;
  findingCounts: Record<string, number>; // findingId -> affected shoppers
}

export const MIN_SHOPPERS = 10;
export const MAX_SHOPPERS = 1000;
