# Calderyn — Adoption Simulation (synthetic user panel)

Maintained by the hourly sweep. Models whether real Shopify merchants would activate,
trust, and keep using Calderyn, grounded in the actual UI code. Each run: run a fresh
persona panel (Sonnet sub-agents), reconcile with this file, ACT on the top friction
points (see the OWNER-SEEDED BACKLOG in `RELEASE_READINESS.md`), and update below.

## Run — 2026-06-11 ~10:15 UTC (hourly sweep)

- **Actual evaluations this run:** 28 distinct personas in 2 parallel batches
  (A: 14 small/skeptical, $200K–$1.5M GMV; B: 14 mid/large tool-experienced,
  $2M–$20M GMV, TripleWhale/Northbeam/Polar veterans), each grounded in reads of the
  real routes/components. **Cumulative:** 70 (incl. the 42-persona owner seed).
  **Modeled population:** weighted to ~2,000 installs at a 75% A-segment / 25%
  B-segment app-store mix. A model, not real user data; honest caveat — batch B
  skewed optimistic on onboarding (100% completion) vs the seed run's ~50%.
- **Headline (panel state = BEFORE this run's fixes landed):**
  activation (onboarding complete) ≈ 64% (A) / 100% (B) → weighted ~73%;
  first action ≈ 43% / 57% → ~46%; day-7 ≈ 36% / 71% → ~45%;
  day-30 ≈ 29% / 57% → ~36%; autopilot ≈ ~7% / 43% → ~16%.
  Panel A's own estimate: fixing the U1/U8 guardrail-framing pair (done this run)
  moves A-segment activation 64% → ~78% and day-7 36% → ~50%.

### Funnel (weighted, this run's panel)
| Stage | A (small/skeptical) | B (mid/large) | Weighted |
|---|---|---|---|
| Onboarding complete | 64% | 100% | ~73% |
| First action | 43% | 57% | ~46% |
| Day-7 | 36% | 71% | ~45% |
| Day-30 | 29% | 57% | ~36% |
| Autopilot on | ~7% | 43% | ~16% |

### Top 10 friction (impact × frequency, cross-batch) — status after this run
1. Guardrails/onboarding framing implies auto-execution before autopilot is explained
   (A's #1) — **[CHANGED this run]** U1 copy + U8 conditional card.
2. "30-day projected impact" with zero methodology (both batches; B's #1 as
   "attribution opacity") — **[CHANGED this run]** shared methodology Tooltip +
   unified label (U2). Full attribution-model disclosure remains OPEN (A18).
3. Dead Settings notification checkboxes — autopilot adopters believe they'll be
   notified and won't — **[CHANGED this run]** honest "coming soon" Banner (U3).
4. "All clear"/dual empty state on first load reads as "dead app" — **[CHANGED this
   run]** "First scan in progress" state (U5).
5. "ranked by Claude" label — **[CHANGED this run]** → "ranked by priority" + tooltip
   (owner decision).
6. OAuth top-level redirect with no warning (uninstall trigger for low-trust
   merchants) — **[CHANGED this run]** reassurance line in OAuthStep.
7. No CSV/export anywhere (B: blocks analyst-backed teams) — **[OPEN → A19]**.
8. Recovered (7d) tile shows $0 right when the merchant looks for ROI proof
   (realized impact attributed later) — **[OPEN → A20]**; audit page already shows
   "est." fallback, the home tile doesn't.
9. Raw GIDs/uuids in evidence panel (incl. "covert access" paranoia when platform
   not connected) — **[CHANGED this run]** suppressed via INTERNAL_EVIDENCE_ID_KEYS (U9).
10. No cost-source/data-freshness disclosure on margin-adjusted ROAS ("Real
    return") — **[OPEN → A21]**.

Also fixed from panel/trace findings: audit `actor` raw strings → "You/Autopilot";
audit broken `image=""` EmptyState → real empty state; "Rank #N" badge → "Priority
#N" + explainer tooltip; campaigns zero-row table → empty state with connect CTA;
assistant DraftActionCard money now matches the alert page; assistant slideout
rolls back unprocessed messages on error + Enter-to-send; `fmtRelTime` caps at 30d;
"hold rate" jargon; favicon 404 noise in prod logs.

### Biggest single blocker (now)
**Trust/verifiability of the dollar numbers for tool-experienced merchants** (B
segment): no attribution model/window/cost-source disclosure anywhere (A18/A21),
compounded by the Recovered-tile $0 moment (A20). The U2 tooltip is a first step;
a "how we compute this" methodology surface is the highest-leverage remaining item.

### Notable new single findings (not yet acted)
- TikTok is a supported platform (campaigns, settings, OAuth code paths) but has NO
  onboarding step — $100K+/mo TikTok spenders hit a silent gap (→ A22).
- `reallocate_budget` alert deep-link drops all alert context on the campaigns page
  (→ A23, known-class, still present).
- No multi-user/team affordances; consent checkbox default-on nuance (logged, low pri).

---

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
