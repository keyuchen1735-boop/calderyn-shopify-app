// Single source of truth for the guardrail defaults a shop gets before it has
// saved its own: pre-filled by the onboarding form (routes/app.onboarding.tsx)
// and served by guardrails.get() when no guardrail_config row exists yet
// (lib/calderyn.server.ts). Cents, matching GuardrailConfig.
export const DEFAULT_GUARDRAILS = {
  daily_action_budget_cents: 250_000, // $2,500/day
  dollar_cap_cents: 100_000, // $1,000/action
  cooldown_minutes: 30,
} as const;
