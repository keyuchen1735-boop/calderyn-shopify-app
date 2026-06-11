# Calderyn — Adoption Simulation (synthetic user panel)

Maintained by the hourly sweep. Models whether real Shopify merchants would activate,
trust, and keep using Calderyn, grounded in the actual UI code. Each run: run a fresh
persona panel (Sonnet sub-agents), reconcile with this file, ACT on the top friction
points (see the OWNER-SEEDED BACKLOG in `RELEASE_READINESS.md`), and update below.

## Seed run — 2026-06-11 (one-off owner analysis, before the hourly Opus sweeps)

- **Actual evaluations:** 42 distinct personas (diverse: $300K–$15M GMV, all ad-channel
  mixes, varied tech-savvy/skepticism/prior-tools). **Modeled population:** weighted to the
  private-beta merchant range. This is a model, not real user data.
- **Headline adoption:** ~15–20% of installs ever take an action; ~5% active at day 30;
  autopilot adoption ~0–1% at this stage.

### Drop-off funnel
| Stage | Pass | Cumulative |
|---|---|---|
| Install | 100% | 100% |
| Onboarding complete (≥ ad OAuth) | ~50% | 50% |
| First alert seen | ~70% | 35% |
| First action taken | ~45% | 16% |
| Day-7 retention | ~55% | 9% |
| Day-30 retention | ~60% | 5% |
| Autopilot on | ~15% | <1% |

### Top friction / distrust (ranked) — mapped to backlog IDs
1. **Guardrails step asks for $ limits before explaining the product / that autopilot is
   off by default** → merchants bail or set $0 (breaks the budget meter). **[BIGGEST BLOCKER → U1]**
2. "30-day projected impact" dollar figure has no methodology/sourcing → top trust-killer **[U2]**
3. 8-step onboarding doesn't signal that only 2 steps are required **[U7]**
4. First-load "All clear" before the first scan looks broken **[U5]**
5. "ranked by Claude" is confusing + raises privacy questions **[OWNER DECISION → "ranked by priority"]**
6. "Before Calderyn acts" card implies auto-action by default (it's off) **[U8]**
7. OAuth full-page redirect with no "you'll be returned here" reassurance
8. Audit log (strongest trust asset: undo + history) buried as 4th nav item, named like compliance
9. Evidence panel shows raw Shopify GIDs **[U9]**
10. Settings notification checkboxes are non-functional **[U3]**

### Strongest positive signals (don't regress these)
- Audit log + undo button + estimated-vs-actual impact column (cited by skeptics as the
  reason they'd trust autopilot). Surface them **earlier** in the journey.
- "projected 30-day impact" as a motivator for Triple Whale / Northbeam defectors — but
  only once it's explained (see U2).

### Biggest single adoption blocker
**U1** — one sentence in the guardrails onboarding step ("By default Calderyn only acts when
you approve it; these limits apply if you later turn on Autopilot") directly addresses the
#1 reason install→activation collapses. Zero new screens.
