// Client-only presentation types for the Store studio chat rail. Kept apart
// from store-logic.ts (which holds the pure, tested parsing/decision logic) —
// this file just shapes what ChatRail renders.
import type { BuildPhase } from "../screens/store-logic";

export interface ChatAction {
  label: string;
  onClick: () => void;
  /** Unset renders as a quiet chip; "primary" renders as a filled button. */
  kind?: "primary";
}

export type ChatMsg =
  | { id: number; kind: "user-text"; text: string }
  | { id: number; kind: "user-image"; imageUrl: string; caption: string }
  | { id: number; kind: "ai-text"; text: string; actions?: ChatAction[] }
  | { id: number; kind: "ai-thinking" }
  /** Carries its OWN phase snapshot (updated in place by the runBuild call
   *  that owns it) rather than reading a shared live signal — a later,
   *  unrelated build must never flip an older, already-finished card in the
   *  thread back to "running". */
  | { id: number; kind: "ai-working"; phase: BuildPhase };
