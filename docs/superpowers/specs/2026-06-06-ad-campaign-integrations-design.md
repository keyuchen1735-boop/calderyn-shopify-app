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
  • Security: TikTok tokens → encrypted store, least-privilege scopes;
    cron reuses constant-time bearer auth
  • Rate limiting: per-platform backoff+jitter on 429, batch + cache metadata,
    bounded concurrency pool across shops (no thundering herd)
    ⇡ Meta & TikTok are independent → parallel

Slice 2  ATTRIBUTION             ← needs Slice 1 data
  • Storefront snippet: capture fbclid/gclid/ttclid + UTM
  • ad_click_ref table + attribution_fact confidence column
  • Matcher: click-ID → UTM → platform-reported, stamp confidence
  • Feed revenue_attrib_cents for the grader
  • Security: consent-gated Web Pixel capture, input sanitize, ad_click_ref
    RLS + retention purge + GDPR redact-webhook handling

Slice 3  ACTIONS                 ← needs adapter from Slice 1
  • pause + cut-budget across all 3 platforms via adapter
  • action_audit pre/post + one-click undo wired end-to-end
  • Security: campaign ownership check + idempotency key before any API call;
    action_audit append-only

Slice 4  AUTO-PILOT              ← wraps Slice 3
  • Make guardrail_config enforcing (not advisory)
  • Guardrail check wrapping the action path
  • Settings UI for the rules; off by default
  • Security: daily action cap + global kill-switch; enabling auto-pilot is audited
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
| Storefront | Consent-gated Web Pixel capturing click-ID/UTM + cart-attribute plumbing |
| Attribution matcher | New server step in ingest pipeline; input sanitize on untrusted click-ID/UTM |
| Action executor | Route action kind → `adapter.pause/setBudget`; ownership + idempotency check; audit + undo |
| `guardrail_config` enforcement | New check wrapping the action path + daily cap + kill-switch |
| GDPR webhooks | `shop/redact` + `customers/redact` purge `ad_click_ref`; scheduled retention purge |

## Security & data safety

This feature handles OAuth tokens, real ad-spend mutations, and shopper-derived
tracking data. Controls below build on the existing posture (PR #6: RLS,
encrypted credentials, `security_invoker` views, constant-time cron auth).

### Credentials & secrets
- TikTok tokens reuse the existing **`integration_credentials` AES-256-GCM** store —
  no plaintext tokens at rest, never written to logs or `raw_*_poll` payloads.
- Request **least-privilege OAuth scopes**: read metrics + manage campaigns only;
  no account-admin or billing scopes.
- TikTok client ID/secret live in **`.env.local` only**, never committed (CLAUDE.md rule).
- Token refresh failures set `shop_integrations.sync_status='error'` — never silently
  retry with a stale token.

### Tenant isolation (RLS)
- New `ad_click_ref` table gets **RLS scoped by `current_shop_id()`**; merchant
  sessions read only their own rows.
- Workers/ingest use the service role (bypasses RLS for writes) — every write path
  must set `shop_id` explicitly from the authenticated context, never from request input.
- New tables/views added under the **cross-shop tenant-isolation regression guard**.
- Any new view stays **`security_invoker`**; any new RPC has anon `EXECUTE` revoked.

### Shopper data & privacy (storefront capture — the main new surface)
- Click-IDs (`fbclid`/`gclid`/`ttclid`) + UTM are **tracking identifiers**: capture
  only via the **Shopify Web Pixel sandbox**, gated on **Customer Privacy / consent mode**
  (no capture when the shopper hasn't consented to marketing tracking).
- **Data minimization:** store click-ID + UTM only — never additional shopper PII.
- **Retention:** `ad_click_ref` rows purged on a schedule (e.g. 90 days) once matched
  or expired; attribution result persists in `attribution_fact`, the raw breadcrumb does not.
- Honor deletion: `shop/redact` + `customers/redact` GDPR webhooks must purge related
  `ad_click_ref` rows.

### Untrusted input
- Click-IDs and UTM params arrive from **attacker-controllable** URLs and cart
  attributes. On ingest: **length-cap, allowlist-charset sanitize**, store via
  parameterized writes only. On render: escape (Polaris escapes by default — no
  `dangerouslySetInnerHTML`).
- The `orders/create` webhook stays HMAC-verified via `authenticate.webhook`; cart
  attributes within it are treated as untrusted and validated before use.

### Action execution (spends/changes real money)
- Every action path is behind **`authenticate.admin`**; auto-pilot runs server-side
  under the shop's own service context.
- **Ownership check:** before any platform API call, verify the target campaign's
  `shop_id` matches the acting shop — prevents acting on another tenant's campaign.
- **Idempotency:** actions carry an idempotency key so a retry can't double-pause or
  double-cut budget.
- **Audit integrity:** `action_audit` is append-only (inserts only, no updates/deletes);
  every action records `pre_state`/`post_state` for undo + forensic trail.

### Auto-pilot safety
- Guardrails are **enforced** (not advisory): the check wrapping the action path
  hard-blocks any auto-action outside bounds.
- **Daily action cap** + a **global kill-switch** (disable all auto-pilot for a shop)
  bound runaway automated spend changes.
- Auto-pilot **off by default**; enabling it is an explicit, audited merchant action.

### Cron / engine endpoints
- `cron.ingest-ads` reuses the existing **constant-time bearer compare + UUID-validate
  `shop_id`** guard (commit `fcc96ec`); no unauthenticated trigger path.

## Rate limiting & cost control

The expensive/risky call paths fall into three buckets. Note: **as scoped, this
feature makes no Anthropic (LLM) calls** — narratives stay templated (a non-goal).
The Anthropic controls below are pre-defined for *if* LLM narratives are switched
on later, so cost governance is designed in, not retrofitted after a surprise bill.

### Ad-platform API polls (Meta / Google / TikTok)
These APIs are free but **rate-limited**; abuse causes throttling, failed ingest,
or app-flagging — not a direct bill, but it breaks the product.
- **Respect documented limits** per platform (Meta business-use-case limits, Google
  Ads operations/day quota, TikTok QPS). Honor `Retry-After` / throttle headers.
- **Exponential backoff with jitter** on 429 / rate-error responses; cap retries,
  then mark `sync_status='error'` rather than hammering.
- **Batch** requests (GAQL/Meta batch endpoints) and **cache unchanged campaign
  metadata** — only re-poll metrics that moved (yesterday's window), not full history.
- **Stagger polls across shops** in `cron.ingest-ads` (no thundering herd): a
  **bounded concurrency pool**, not a fan-out of all shops × all adapters at once.

### Action / budget mutations — the real payment-spike vector
Changing budgets is the one path that moves real money. Covered by Layer 4:
- **Auto-pilot daily action cap**, per-guardrail size limits, and a **global
  kill-switch** bound automated spend changes.
- **Idempotency keys** prevent a retry storm from double-applying a budget change.
- One-click actions are inherently human-paced; auto-pilot is the only unattended
  path and is hard-bounded above.

### Anthropic / LLM calls (only if narratives are turned on later)
If `claude_narrative` / `claude_rank` ever become LLM-generated, they must ship with:
- **Per-shop daily budget**: a request cap *and* a token cap; exceeding it falls back
  to templated narratives, never silently keeps spending.
- **Response cache** keyed on an alert-content hash — never re-narrate an unchanged
  alert; identical inputs return the cached narrative.
- **Bounded output** (`max_tokens`) + **batch** multiple alerts into one call rather
  than one call per alert.
- **Circuit breaker**: trip and disable LLM narration shop-wide if a cost threshold
  is crossed in a window; alert the operator.
- **Prompt caching** on the shared system prompt to cut per-call cost; pick the
  cheapest sufficient model (e.g. Haiku for ranking).
- Reuse the existing assistant feature's Anthropic client/guardrails — one cost-
  control path, not two.

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
- **Security:** ownership-check rejects acting on another shop's campaign; idempotency
  key blocks double-actions; sanitizer rejects oversized/malformed click-IDs + UTM;
  consent-off path captures nothing; guardrail + kill-switch hard-block auto-actions;
  cron rejects bad/missing bearer.
- **Rate limiting:** 429/throttle response triggers backoff (not immediate retry storm);
  retry cap reached → `sync_status='error'`; cron concurrency pool never exceeds its
  bound; (if LLM on) per-shop token/request cap falls back to templated, cache hit
  skips the call, circuit breaker trips at threshold.

## Open questions / risks

- **TikTok Marketing API access** requires app registration/approval — may gate Slice 1's
  TikTok portion on credentials. Meta + Google can proceed independently.
- **Storefront injection mechanism** (theme app extension vs. script tag vs. web pixel)
  needs to be chosen in Slice 2 planning; web pixel extension is the modern Shopify path.
- **Platform-reported reconciliation** semantics (how to avoid double-counting against
  click-ID/UTM matches) to be specified in Slice 2 planning.
