import type { BuildPhase } from "../screens/store-logic";

export interface ChatAction {
  label: string;
  onClick: () => void;
  kind?: "primary";
}

export type ChatMsg =
  | { id: number; kind: "user-text"; text: string }
  | { id: number; kind: "ai-text"; text: string; actions?: ChatAction[] }
  | { id: number; kind: "ai-working"; phase: BuildPhase }
  // Designer-engine kinds: the sparkle studio's thread renders these; the
  // classic builder never produces them.
  | { id: number; kind: "ai-thinking" }
  | { id: number; kind: "user-image"; imageUrl: string; caption: string };
