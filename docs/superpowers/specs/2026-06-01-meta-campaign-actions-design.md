# Design: Real Meta Campaign Actions (Slice A — pause/resume)

**Date:** 2026-06-01
**Status:** Approved for implementation planning
**Repo affected:** `shopify-app` (this repo) + Supabase project `Calderyn-SHOPIFY`

---

## 1. Context

The action layer is real and complete as a framework: typed `ActionKind`s, an
idempotent `actions.execute` (writes `action_audit` + `action_idempotency`),
`audit.undo`, and guardrail display. One action — `reallocate_inventory` —
already executes against a real external API via
`app/lib/shopify/inventory.server.ts` (`inventoryAdjustQuantities`, with
`userErrors` checking).

The ad-platform actions (`pause_campaign`, `reduce_campaign_budget`,
`exclude_geo`) flow through the same `execute()` path but **skip the external
call** — they only record an audit row. There is no Meta API client and
`integrations.startOAuth("meta")` throws `OAUTH_NOT_WIRED`. So clicking "Pause"
records a "succeeded" audit row while Meta is never contacted. This slice closes
that gap for **pause/resume**.

## 2. Goal & success criteria

After a merchant connects Meta and clicks Pause/Resume on a campaign:

1. A real Meta Marketing API call sets the campaign `status` to `PAUSED`/`ACTIVE`.
2. The `action_audit` row records the true prior status (`pre_state`) and new
   status (`post_state`) plus the Meta campaign id.
3. Undo re-calls Meta to restore the prior status (not just an inverse row).
4. Meta API errors surface to the merchant and are never swallowed.
5. Tokens are encrypted at rest.

## 3. Non-goals

- Budget edits (`reduce_campaign_budget`) and geo exclusions (`exclude_geo`) —
  later slices; the framework already supports the kinds.
- Meta ad **ingestion** (Slice 2 / `v_campaigns_flat` poller). Campaigns are
  live-fetched directly for this slice.
- Google Ads.
- Meta **App Review**. Development-mode access (`ads_management` against an ad
  account the user has a role on) is sufficient to build and test; App Review is
  only required to manage other merchants' accounts in production (tracked
  separately).

## 4. Decision: campaign source

Live-fetch from Meta. After OAuth the Meta client reads the ad account's
campaigns directly (`GET /act_<id>/campaigns`); the Campaigns page acts on those
live rows, which carry the Meta campaign id to pass to the pause call. Decoupled
from the unbuilt Slice 2.

## 5. Architecture

Mirror the `inventory.server.ts` seam: a pure-ish client module that takes an
**injected** HTTP client, so request-shape and error handling are unit-tested
with a fake (no creds).

```
Connect ─startOAuth("meta")─> Meta OAuth dialog ─callback─> exchange code →
         long-lived token → integration_credentials (encrypted) + shop_integrations(status)

Campaigns loader ─(if connected)─> listCampaigns(metaClient, adAccountId) → live rows
Pause/Resume     ─> setCampaignStatus(metaClient, campaignId, PAUSED|ACTIVE)
                  → actions.execute(pre_state=prior, post_state=new, meta ref)
Undo             ─> setCampaignStatus(... restore pre_state.status) → inverse audit row
```

### 5.1 Module layout

| Module | Responsibility | Testable now? |
|---|---|---|
| `app/lib/meta/campaigns.server.ts` | `listCampaigns`, `setCampaignStatus`; Graph error → throw | ✅ fake client |
| `app/lib/meta/client.server.ts` | Build an authed Graph client for a shop (loads + decrypts token) | partial |
| `app/lib/meta/oauth.server.ts` | Build dialog URL; exchange code → long-lived token | ✅ fake fetch |
| `app/lib/crypto.server.ts` | AES-256-GCM `encrypt`/`decrypt` (`INTEGRATION_ENCRYPTION_KEY`) | ✅ round-trip |
| `app/routes/auth.meta.$.tsx` | OAuth callback: exchange + store credential | via oauth module |
| `integrations.startOAuth` (calderyn.server.ts) | Return the dialog redirect URL (replace the throw) | ✅ |
| `app.campaigns.tsx` action/loader | Live-fetch; pause/resume branch (mirrors `reallocate_inventory`) | ✅ fake client |
| `audit.undo` (calderyn.server.ts) | Re-call Meta for ad-platform kinds to restore status | ✅ fake client |

Pin a recent Graph API version (e.g. `v21.0`).

## 6. Meta client contract

- `listCampaigns(client, adAccountId)` → `GET /act_<id>/campaigns?fields=id,name,status,effective_status,daily_budget` → `{ id, name, status, effectiveStatus, dailyBudgetCents }[]`.
- `setCampaignStatus(client, campaignId, "PAUSED"|"ACTIVE")` → `POST /<campaign-id>` body `status=...` → `{ success: true }`.
- Meta returns errors as `{ error: { message, type, code, fbtrace_id } }`. Any
  `error` (or non-2xx) → throw an `Error` with `code: message` (mirrors the
  inventory module's `userErrors` handling). Never swallowed.
- `client` is an injected interface (`post`/`get` returning the parsed body), so
  tests pass a fake; production wraps `fetch` against `graph.facebook.com`.

## 7. OAuth + token storage

- `startOAuth("meta")` → `https://www.facebook.com/v21.0/dialog/oauth?client_id=<META_APP_ID>&redirect_uri=<app>/auth/meta&scope=ads_management,ads_read&state=<signed nonce>`.
- Callback `auth.meta.$.tsx`: verify `state`, exchange `code` for a short-lived
  token, then exchange for a **long-lived** token; read the user's ad account id;
  encrypt the token; upsert `integration_credentials`; set
  `shop_integrations(kind=meta_ads, sync_status=ready, external_account_id)`.
- `integrations.list` already maps `meta_ads` → "connected", so UI updates free.

### 7.1 `integration_credentials` (new Supabase table)

```
shop_id uuid           references shops(id) on delete cascade
kind    integration_kind                     -- 'meta_ads'
access_token_encrypted text not null
token_expires_at       timestamptz
external_account_id    text                   -- ad account id (act_<id>)
created_at / updated_at timestamptz
primary key (shop_id, kind)
```

Secrets live here (separate from `shop_integrations` metadata). Encrypted at
rest, so the open `mcp_tokens` RLS advisory does not expand exposure; all writes
use the service-role key.

## 8. Crypto

`encrypt(plaintext)` / `decrypt(ciphertext)` — AES-256-GCM, 32-byte key from
`INTEGRATION_ENCRYPTION_KEY` (hex). Ciphertext stores `iv:authTag:data`.
Round-trip + tamper-rejection unit tests.

## 9. Undo

Undoing a `pause_campaign` must restore the prior Meta status, not just write an
inverse row. The undo path: read the original audit's `pre_state.status`, call
`setCampaignStatus(client, metaCampaignId, prior)`, then write the inverse audit
row (existing behavior). Failure surfaces; no inverse row written if the Meta
call fails.

## 10. Schema changes (Supabase migration — same carve-out as ingestion)

CLAUDE.md's "schema via `prisma migrate`" governs only `shopify_sessions`. The
`integration_credentials` table is Supabase-managed, applied via Supabase
migration tooling (per ingestion spec §10). One migration: create
`integration_credentials` (§7.1).

## 11. New environment variables (add to `.env.example`)

- `META_APP_ID`, `META_APP_SECRET` — the Meta developer app (development mode is
  enough for own-account testing).
- `INTEGRATION_ENCRYPTION_KEY` — 32-byte hex for token encryption.

## 12. Testing (behavior, not coverage theater)

- **Meta client** — fake client; assert request path/body for list + setStatus,
  and that a Graph `error` payload throws with the message.
- **Crypto** — encrypt→decrypt round-trips; tampered ciphertext throws.
- **OAuth** — dialog URL contains scope/state/redirect; callback exchange logic
  maps token response → stored credential (fake fetch).
- **Pause branch** — fake Meta client; assert it is called with the right
  campaign id/status and that `actions.execute` records prior/new status; Meta
  error → action fails, no "succeeded" row.
- **Undo** — fake client; asserts restore call + inverse row; client failure →
  no inverse row.

What cannot be unit-tested (needs the Meta dev app, no App Review): the live
browser OAuth handshake and a real pause against the user's ad account.

## 13. Pre-commit gate

Per CLAUDE.md: `/code-review`, patch sanity, then `npm test` → `npm run
typecheck` → `npm run lint` → `npm run build`, all green with evidence, before
commit. No `prisma/schema.prisma` change → no Prisma migration/codegen.
