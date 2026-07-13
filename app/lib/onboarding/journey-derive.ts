import type { MilestoneKey } from "~/lib/dashboard/journey-model";

export interface JourneySignals {
  productCount: number; payoutsReady: boolean; originSet: boolean; rateCount: number;
  storefrontPublished: boolean; testOrderCount: number; realOrderCount: number;
  autopilotEnabled: boolean; assistantConvoCount: number;
}

export function deriveDone(s: JourneySignals): Set<MilestoneKey> {
  const done = new Set<MilestoneKey>(["account"]);
  if (s.productCount > 0) done.add("first_product");
  if (s.payoutsReady) done.add("payouts");
  if (s.originSet && s.rateCount > 0) done.add("shipping");
  if (s.storefrontPublished) done.add("storefront_published");
  if (s.testOrderCount > 0) done.add("test_order");
  if (s.realOrderCount > 0) done.add("first_order");
  if (s.autopilotEnabled) done.add("autopilot_on");
  if (s.assistantConvoCount > 0) done.add("ask_calderyn");
  return done;
}
