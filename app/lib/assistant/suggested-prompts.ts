// Client-safe: the empty-state prompt chips, shared by the embedded slideout
// and the dashboard chat so the two surfaces always suggest the same things.
export const SUGGESTED_PROMPTS = [
  "What should I fix first?",
  "Which campaigns are losing money?",
  "What's at risk of selling out?",
  "What changed in the last week?",
] as const;
