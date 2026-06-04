// app/lib/assistant/types.ts
// DTOs for the in-app assistant. Kept separate from app/lib/types.ts to avoid
// churn on that shared file (spec §14).
import type { ActionKind } from "../types";

export type ChatRole = "user" | "assistant";

export interface DraftedAction {
  alertId: string;
  actionKind: ActionKind;
  label: string;
  dollarImpact: number; // cents, mirrors Alert.dollar_impact
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  draftedAction: DraftedAction | null;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}
