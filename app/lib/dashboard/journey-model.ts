export type MilestoneKey =
  | "account" | "first_product" | "payouts"
  | "shipping" | "storefront_published" | "test_order"
  | "autopilot_on" | "ask_calderyn" | "first_order";

export type JourneyPhase = 1 | 2 | 3;

export interface JourneyStepDef {
  key: MilestoneKey; phase: JourneyPhase; label: string; pitch: string; cta: string; screen: string;
}

export const PHASE_TITLES: Record<JourneyPhase, string> = {
  1: "Foundation", 2: "Launch", 3: "First wins",
};

export const JOURNEY_STEPS: JourneyStepDef[] = [
  { key: "account", phase: 1, label: "Create your account", pitch: "", cta: "", screen: "" },
  { key: "first_product", phase: 1, label: "Add your first product",
    pitch: "One sentence — Calderyn drafts the listing. Or import your Shopify catalog.",
    cta: "Create", screen: "product-editor" },
  { key: "payouts", phase: 1, label: "Connect payouts",
    pitch: "Stripe, about two minutes.", cta: "Connect", screen: "payments" },
  { key: "shipping", phase: 2, label: "Set up shipping",
    pitch: "Where you ship from, and one rate.", cta: "Set up", screen: "shipping" },
  { key: "storefront_published", phase: 2, label: "Publish your storefront",
    pitch: "Describe your brand — go live when it looks right.", cta: "Open", screen: "storefront" },
  { key: "test_order", phase: 2, label: "Place a test order",
    pitch: "A 50¢ run through your own checkout, refunded automatically.",
    cta: "Run test", screen: "__test_order" },
  { key: "autopilot_on", phase: 3, label: "Turn on Autopilot",
    pitch: "It watches inventory, pricing and ads — you approve the moves.",
    cta: "Turn on", screen: "autopilot" },
  { key: "ask_calderyn", phase: 3, label: "Ask Calderyn anything",
    pitch: "Try: “what should I fix first?”", cta: "Ask", screen: "__assistant" },
  { key: "first_order", phase: 3, label: "First real order",
    pitch: "This one completes itself.", cta: "", screen: "" },
];

// Toast fragments per completed step ("<done> — next: <verb next>").
const DONE_LABELS: Record<MilestoneKey, string> = {
  account: "Account created",
  first_product: "First product added",
  payouts: "Payouts connected",
  shipping: "Shipping set up",
  storefront_published: "Storefront live",
  test_order: "Test order placed",
  autopilot_on: "Autopilot on",
  ask_calderyn: "Assistant unlocked",
  first_order: "First order",
};
const NEXT_LABELS: Record<MilestoneKey, string> = {
  account: "create your account",
  first_product: "add your first product",
  payouts: "connect payouts",
  shipping: "set up shipping",
  storefront_published: "publish your storefront",
  test_order: "place a test order",
  autopilot_on: "turn on Autopilot",
  ask_calderyn: "ask Calderyn anything",
  first_order: "your first real order",
};

export interface JourneyStepState { def: JourneyStepDef; done: boolean; completedAt: string | null }

export interface JourneyView {
  phase: JourneyPhase; retired: boolean; next: MilestoneKey | null;
  steps: JourneyStepState[]; phasesComplete: JourneyPhase[];
  showRecap: boolean; showLiveCard: boolean;
}

// A shop whose entire history was stamped by one backfilling recompute never
// "did" the journey — suppress the celebration surfaces for it. 5 minutes
// comfortably exceeds one recompute pass while never misreading a real user,
// for whom consecutive steps are minutes-to-days apart.
const BACKFILL_WINDOW_MS = 5 * 60 * 1000;

function withinBackfill(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) < BACKFILL_WINDOW_MS;
}

export function journeyView(input: {
  completed: Partial<Record<MilestoneKey, string>>;
  liveCardDismissed: boolean;
  recapDismissed: boolean;
}): JourneyView {
  const { completed } = input;
  const steps: JourneyStepState[] = JOURNEY_STEPS.map((def) => ({
    def, done: completed[def.key] != null, completedAt: completed[def.key] ?? null,
  }));
  const phaseDone = (p: JourneyPhase) => steps.filter((s) => s.def.phase === p).every((s) => s.done);
  const phasesComplete = ([1, 2, 3] as JourneyPhase[]).filter(phaseDone);
  const phase: JourneyPhase = !phaseDone(1) ? 1 : !phaseDone(2) ? 2 : 3;
  const retired = completed.first_order != null;
  const next = steps.find((s) => s.def.phase === phase && !s.done)?.def.key ?? null;
  const backfilledRetire = withinBackfill(completed.first_order, completed.account);
  const backfilledPublish = withinBackfill(completed.storefront_published, completed.account);
  return {
    phase, retired, next, steps, phasesComplete,
    showRecap: retired && !input.recapDismissed && !backfilledRetire,
    showLiveCard:
      completed.storefront_published != null && !retired &&
      !input.liveCardDismissed && !backfilledPublish,
  };
}

export function journeyToastText(doneKey: MilestoneKey, next: MilestoneKey | null): string {
  if (!next) return `${DONE_LABELS[doneKey]} — setup complete.`;
  return `${DONE_LABELS[doneKey]} — next: ${NEXT_LABELS[next]}`;
}
