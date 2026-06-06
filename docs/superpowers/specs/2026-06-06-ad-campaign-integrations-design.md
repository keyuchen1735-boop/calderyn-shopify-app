# Ad Campaign Integrations — Design Spec

**Date:** 2026-06-06
**Status:** Approved (design); pending implementation planning
**Author:** John Duncan (with Claude)

## Problem

Calderyn needs to answer one question for a merchant, honestly and per-campaign:
**"Is this ad campaign making money, or burning it — and what should I do about it?"**

The grading engine (`engine/calderyn_engine/grade.py`) and the fact-table schema
already exist. What's missing is (1) real data flowing in from every ad platform,
(2) trustworthy attribution from orders back to ads, and (3) the ability to act on
the verdict. This spec covers all three plus an opt-in auto-pilot.

## Goals

- Ingest spend + performance metrics from **Meta (Facebook + Instagram), Google, and TikTok**.
- Attribute Shopify orders back to the ad that earned them, with a **confidence level** on every match.
- Grade each campaign **winning / okay / poor** against a *per-campaign* break-even ROAS (already built; this work feeds it real data).
- Let merchants act with **one-click actions** (pause, cut budget) across all 3 platforms.
- Offer an **opt-in auto-pilot** that performs those same actions automatically, bounded by merchant guardrails.

## Non-Goals (this build)

- TikTok/Snapchat beyond TikTok; other platforms.
- Action types beyond pause + cut-budget (region-exclusion, inventory moves, PO drafts stay stubbed for a later slice).
- LLM-generated alert narratives (templated narratives stay as-is).
- Cross-device deterministic identity resolution (we accept the industry-standard gap; see Attribution limits).

---

## Architecture: the adapter pattern

Three platforms speak three different APIs. Rather than copy the ingestion/action
code three times (the current state — Meta and Google are built two different ways),
we define **one adapter contract** that each platform implements. Everything above
the adapter — grading, actions, auto-pilot — is written **once** and is platform-blind.

```
   Meta            Google          TikTok          ← Adapters (only platform-specific code)
  (FB + IG)                                            each implements the same contract
     └───────────────┴───────────────┘
                     │  normalize → shared tables
                     ▼
         ad_campaign_dim / ad_spend_fact / attribution_fact   ← one shape for all platforms
                     │
                     ▼
              Grading engine (grade.py)            ← already exists, platform-blind
                     │
                     ▼
        Alerts → one-click actions → auto-pilot
```

### The adapter contract

Each platform module under `app/lib/<platform>/` exposes the same shape so the
ingestion orchestrator and action executor never branch on platform:

```ts
interface AdPlatformAdapter {
  readonly platform: "meta" | "google" | "tiktok";

  // Ingestion
  listCampaigns(client, accountId): Promise<NormalizedCampaign[]>;
  fetchMetrics(client, accountId, range): Promise<NormalizedSpendRow[]>;

  // Actions (Slice 3)
  pauseCampaign(client, externalId): Promise<void>;
  setBudget(client, externalId, dailyBudgetCents): Promise<void>;
  getCampaignState(client, externalId): Promise<{ status: string; dailyBudgetCents: number | null }>;
}
```

`NormalizedSpendRow` is the existing `ad_spend_fact` shape (`spend_cents`,
`impressions`, `clicks`, `conversions`, `revenue_attrib_cents`, `day`).
Google's current `ingest.server.ts` becomes the reference implementation: its
`transform.ts` → normalized-row step is exactly what each adapter does internally.

**Refactor note:** the existing per-platform poller orchestration
(`cron.google.tsx`) collapses into one `cron.ingest-ads` route that loops every
`ready` shop × every connected adapter. This removes the divergence between the
Meta and Google code paths.

---

## Layer 1 — Is this campaign working? (Grading)

**Already implemented in `grade.py`.** Documented here because the rest of the
build exists to feed it trustworthy inputs.

The verdict is `money in ÷ money out` vs. a **per-campaign** break-even:

```
  ROAS = attributed_revenue / ad_spend
  break_even_roas = 1 / contribution_margin     (margin derived from real COGS)

  winning  if ROAS ≥ 1.2  × break_even
  okay     if ROAS ≥ 0.95 × break_even
  poor     otherwise
```

Why per-campaign break-even matters — same ROAS, opposite verdict:

| | Campaign A | Campaign B |
|---|---|---|
| Spend | $1,000 | $1,000 |
| Revenue | $3,000 | $3,000 |
| ROAS | 3.0× | 3.0× |
| Product margin | 70% | 25% |
| Break-even ROAS | 1.43× | 4.0× |
| **Verdict** | Winning | **Poor (losing money)** |

**Confidence rule (already in `derive_margin`):** a merchant override wins
(`override`); else if COGS coverage ≥ 70% and revenue > 0 use the computed margin
(`ok`); else fall back to a 40% default margin (`default`). The grade carries this
confidence so the UI can label a verdict as estimated vs. solid.

---

## Layer 2 — Which ad earned which sale? (Attribution)

Three methods, applied in priority order — **best available evidence wins**, and
every attributed order is stamped with the method (which implies its confidence).

```
  Click on ad → lands on store → (maybe) buys
                    │  capture 3 breadcrumbs at the click:
   ┌────────────────┼────────────────────┐
   ▼                ▼                     ▼
1. Click ID      2. UTM tags         3. Platform-reported
  (fbclid/         (utm_source/        conversions
   gclid/           utm_campaign)       (platform's own count)
   ttclid)
  MOST EXACT ───────────────────────────► FUZZIEST
```

| Priority | Method | `attribution_method` | Confidence | When used |
|----------|--------|----------------------|------------|-----------|
| 1 | Click ID match | `click_id` | high | Click ID survived to checkout |
| 2 | UTM exact match | `utm_exact` | strong | URL was tagged, no click ID |
| 3 | Platform-reported reconciliation | `platform_reported` | rough | Cross-check + fallback |
| — | No match | `unknown` | none | Ads ran but order can't be tied |

### Data flow

1. **Storefront capture (new):** a small script tag captures `fbclid` / `gclid` /
   `ttclid` and UTM params on landing, persists them (cookie/localStorage), and
   attaches them to the order via cart attributes / order note attributes so they
   arrive on the `orders/create` webhook.
2. **Match (server, new):** an attribution step in the ingest pipeline resolves
   each order: try click-ID → UTM → platform-reported, write to `attribution_fact`
   with method + confidence. This populates `revenue_attrib_cents` on `ad_spend_fact`
   that the grader reads.

### Schema changes

The `attribution_method` set expands and we add a confidence column:

```sql
-- attribution_fact: widen method vocabulary, add confidence + raw click-id capture
-- method ∈ {'click_id','utm_exact','platform_reported','referrer_host','unknown'}
alter table attribution_fact
  add column confidence text not null default 'none';   -- 'high'|'strong'|'rough'|'none'
-- click-id breadcrumbs (storefront capture) land in their own table keyed to order
create table ad_click_ref (
  id        uuid primary key default gen_random_uuid(),
  shop_id   uuid not null references shops(id) on delete cascade,
  order_id  uuid references order_fact(id) on delete cascade,
  platform  ad_platform,
  click_id  text not null,            -- fbclid / gclid / ttclid value
  utm       jsonb,                    -- captured utm_* params
  captured_at timestamptz not null default now()
);
```

### Honest limits (must surface in UI)

- **Cross-device gap:** ad seen on phone, bought on laptop → breadcrumb breaks.
  No tool tracks this perfectly (Meta's own numbers are estimates). Expect a
  meaningful share of orders to fall back to UTM or platform-reported.
- **Counting mismatch:** the platform's reported conversions won't equal our
  confidently-traced count. That's expected. Our number's advantage: it's tied to
  *real Shopify orders and real margin*, not the platform's self-report.
- Rough split to expect: ~60–75% exact (click-ID/UTM), ~15–25% platform-level,
  ~5–15% unattributable.

---

## Layer 3 — Doing something about it (Actions)

When a campaign grades `poor` or a detector fires, the merchant acts. **One-click
is the default.** Auto-pilot (Layer 4) reuses the exact same execution path.

```
  Alert: "Spring campaign losing money — ~$420/wk"
                    │
        ┌───────────┴───────────┐
        ▼                        ▼
   One-click (default)     Auto-pilot (opt-in, Layer 4)
   [Pause] [Cut budget]    rule fires the same action
        └───────────┬───────────┘
                    ▼
        adapter.pauseCampaign / adapter.setBudget   ← platform API
                    ▼
        action_audit row (pre_state, post_state)  → one-click UNDO
```

**Scope:** `pause_campaign` + `reduce_campaign_budget` only, across all 3 platforms
via the adapter. Other action kinds in `DETECTOR_TO_ACTIONS` stay recorded-but-not-
executed (later slice).

- Every action — clicked or automatic — captures `pre_state` and writes an
  `action_audit` row, making it **undo-able** in one click (the audit/undo UI exists).
- Action execution reads current platform state first (`getCampaignState`) so the
  recorded `pre_state` is true, not assumed (Meta already does this).

---

## Layer 4 — Auto-pilot (opt-in)

Auto-pilot is **one-click with the human stepped out** — it calls the identical
adapter actions, only when a guardrail-checked rule says it's safe. Nothing
auto-pilot can do is something a merchant couldn't do with a single click.

Guardrails (set once in Settings, enforced by a check that wraps the action path —
today's `guardrail_config` is advisory-only and must become enforcing):

| Guardrail | Example |
|-----------|---------|
| Min spend before acting | Don't pause if campaign spent < $200 (too little data) |
| Max auto-action size | Never cut budget more than 50% at once |
| Daily action cap | ≤ 3 auto-actions per day |
| Always-ask list | Never auto-pause the brand campaign |

Auto-pilot is **off by default**. A merchant graduates to it after trusting
one-click. Every auto-action is logged + undo-able exactly like a click.

---

## Build order (slices)

Each slice ships something usable. Independent platform work parallelizes well
(good fit for subagent-driven-development at execution time).

```
Slice 1  DATA FLOWING            ← foundation
  • Define adapter contract
  • Refactor Google into it (proves the shape)
  • Meta poller → FB + IG spend/metrics into ad_spend_fact
  • TikTok adapter + ingestion
  • Add 'tiktok' to ad_platform enum
  • Collapse cron.google → cron.ingest-ads (loops shops × adapters)
    ⇡ Meta & TikTok are independent → parallel

Slice 2  ATTRIBUTION             ← needs Slice 1 data
  • Storefront snippet: capture fbclid/gclid/ttclid + UTM
  • ad_click_ref table + attribution_fact confidence column
  • Matcher: click-ID → UTM → platform-reported, stamp confidence
  • Feed revenue_attrib_cents for the grader

Slice 3  ACTIONS                 ← needs adapter from Slice 1
  • pause + cut-budget across all 3 platforms via adapter
  • action_audit pre/post + one-click undo wired end-to-end

Slice 4  AUTO-PILOT              ← wraps Slice 3
  • Make guardrail_config enforcing (not advisory)
  • Guardrail check wrapping the action path
  • Settings UI for the rules; off by default
```

Grading (Layer 1) is already built; it begins producing trustworthy verdicts once
Slices 1 & 2 feed it real data + confidence.

## Affected / new components

| Area | Change |
|------|--------|
| `app/lib/meta/` | Add adapter conformance + metrics poller + ingest (mirrors `google/ingest.server.ts`) |
| `app/lib/google/` | Refactor to implement the shared adapter contract |
| `app/lib/tiktok/` | New: client, transform, ingest, adapter (TikTok Marketing API) |
| `app/lib/ads/adapter.ts` | New: shared `AdPlatformAdapter` contract + registry |
| `app/routes/cron.ingest-ads.tsx` | New: replaces `cron.google.tsx`; loops shops × adapters |
| `supabase/migrations/` | `'tiktok'` enum value; `attribution_fact.confidence`; `ad_click_ref` table |
| Storefront | Click-ID/UTM capture script + cart-attribute plumbing |
| Attribution matcher | New server step in ingest pipeline |
| Action executor | Route action kind → `adapter.pause/setBudget`; audit + undo |
| `guardrail_config` enforcement | New check wrapping the action path |

## Testing strategy

- **Adapters:** unit tests with fake clients (the existing Meta/Google test pattern) —
  normalize fixture API responses → assert `ad_spend_fact` rows.
- **Attribution matcher:** table-driven tests over the 3 methods + fallbacks; assert
  correct `attribution_method` + `confidence` per scenario, including no-match.
- **Grading:** already covered in `grade.py` tests; add cases for new confidence inputs.
- **Actions:** fake-adapter tests asserting correct API call + `action_audit` pre/post;
  undo round-trips state.
- **Guardrails:** unit tests that each guardrail blocks/permits the action path correctly.
- **Tenant isolation:** new tables (`ad_click_ref`) get RLS + the cross-shop regression guard.

## Open questions / risks

- **TikTok Marketing API access** requires app registration/approval — may gate Slice 1's
  TikTok portion on credentials. Meta + Google can proceed independently.
- **Storefront injection mechanism** (theme app extension vs. script tag vs. web pixel)
  needs to be chosen in Slice 2 planning; web pixel extension is the modern Shopify path.
- **Platform-reported reconciliation** semantics (how to avoid double-counting against
  click-ID/UTM matches) to be specified in Slice 2 planning.
