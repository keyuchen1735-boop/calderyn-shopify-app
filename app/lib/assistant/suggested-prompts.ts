// Client-safe: the empty-state prompt chips, shared by the embedded slideout
// and the dashboard chat so the two surfaces always suggest the same things.
export const SUGGESTED_PROMPTS = [
  "What should I fix first?",
  "Pause my worst-performing campaign",
  "Which campaigns are losing money?",
  "Set my blue hoodie price to $39",
] as const;
