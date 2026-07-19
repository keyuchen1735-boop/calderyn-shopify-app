# Campaign Sales Views and Profit Metrics Design

**Date:** 2026-07-19
**Surface:** Native Calderyn dashboard Campaigns screen
**Status:** Approved design

## Goal

Let merchants distinguish sale-driven campaigns from regular campaigns, create campaigns for named sales events, and judge every campaign using owned order revenue and real product costs instead of platform-reported conversions alone.

Success means:

- Campaigns can be viewed as All, Sales, or Regular.
- A new campaign explicitly records whether it is Sales or Regular.
- Existing synced campaigns are classified automatically and remain editable.
- Every campaign shows attributed orders, profit, true ROAS, spend, status, and score for a selectable 7, 30, or 90-day period.
- Account-wide Orders, Revenue, Profit, and True ROAS cards remain stable when the table category changes.
- Profit prefers QuickBooks costs, falls back to stored catalog costs, and visibly reports incomplete inputs.

## Non-goals

- Forecasting a sale's future performance.
- Generating a holiday calendar or automatically scheduling campaigns.
- Changing ad-platform objectives or turning campaigns on automatically.
- Assigning unattributed orders to campaigns by guesswork.
- Adding a background rollup job or a second analytics store.

## Campaigns screen

The page retains its existing header and New campaign action. Below the header it shows four account-wide cards for the active date window:

1. Attributed orders
2. Attributed revenue
3. Profit
4. True ROAS

A 7 / 30 / 90-day selector controls both the cards and every row metric. The browser stores the merchant's last selection and restores it on the next visit. The first visit uses 30 days.

Below the cards, a three-way segmented control filters the table:

- **All**: every campaign.
- **Sales**: campaigns whose `campaign_kind` is `sales`.
- **Regular**: campaigns whose `campaign_kind` is `regular`.

The tabs affect only table membership. The four account cards always summarize all campaigns in the selected date window.

Card aggregation is deterministic: Orders, Revenue, and Profit are sums; True ROAS is total attributed revenue divided by total spend, never an average of row ratios. The account Profit card is marked incomplete when any included attributed order has incomplete costs.

The table columns are Campaign, Status, Attributed orders, Profit, True ROAS, Spend, Score, and existing quick actions. This replaces the Daily Budget column; budget remains visible in campaign detail and the existing budget editor. Sales rows show their sale type next to the campaign name.

On narrow screens, the existing horizontal table pan remains the responsive behavior.

## Campaign creation

The wizard becomes a five-step flow:

1. Platform
2. Campaign type
3. Product
4. Creative
5. Review

Campaign type offers:

- **Regular campaign**
- **Sales campaign**

Selecting Sales requires one sale type: Black Friday, Cyber Monday, Holiday, Seasonal, General Sale, or a custom label of 1–80 trimmed characters. Review displays the selection before creation. Campaign draft state and wizard-run input snapshots retain the classification so resumed and retried runs cannot lose it.

Everything Calderyn creates remains paused under the current campaign-creation contract.

## Existing campaign classification

`ad_campaign_dim` gains:

- `campaign_kind text not null default 'regular'`, constrained to `sales | regular`
- `sale_type text null`, limited to 80 characters
- `classification_source text not null default 'detected'`, constrained to `detected | merchant`

A database name detector is the single source for initial classification. The migration uses it to backfill existing campaigns, and an insert trigger uses it for campaigns first seen in future Meta, Google, or TikTok syncs. The trigger runs only on insert, so later platform syncs cannot overwrite a merchant edit.

Detection is deliberately conservative and case-insensitive:

1. `cyber monday` maps to Sales / Cyber Monday.
2. `black friday` or `bfcm` maps to Sales / Black Friday.
3. `christmas`, `holiday`, or `boxing day` maps to Sales / Holiday.
4. `spring sale`, `summer sale`, `fall sale`, `autumn sale`, `winter sale`, or `back to school` maps to Sales / Seasonal.
5. `sale`, `discount`, `promotion`, `promo`, or `clearance` maps to Sales / General Sale.
6. Everything else maps to Regular with no sale type.

Merchants can change kind and sale type from a row action or campaign detail. That write sets `classification_source = 'merchant'`. Switching to Regular clears `sale_type`; switching to Sales requires a valid preset or custom label.

## Metric definitions

The API accepts only `window=7`, `window=30`, or `window=90`. The window ends on the shop's latest available ad-spend day, matching the existing campaign analytics anchor rather than mixing partial calendar days.

For each campaign:

- **Attributed orders**: distinct paid orders in `attribution_fact` with this campaign id and an order date inside the window.
- **Attributed revenue**: captured order revenue after recorded refunds for those orders.
- **Spend**: `ad_spend_fact.spend_cents` summed inside the same window.
- **True ROAS**: attributed revenue divided by spend. Zero spend returns `null` and renders as an em dash.
- **Profit**: attributed revenue minus product COGS, matched carrier cost, estimated payment fees, and campaign spend.

COGS uses the effective cost attached to each ordered SKU for the order period. QuickBooks is preferred when available; otherwise the stored catalog cost is used. No missing cost is silently treated as known. The response includes cost completeness and cost-source labels so the UI can mark a best-known result as incomplete.

Carrier cost follows the existing manual-override-then-resolved-cost precedence. Missing carrier cost also marks the profit incomplete. Payment fees use the existing order-profit estimate until real processor fees exist. Refunds reduce attributed revenue before ROAS and profit are calculated.

Unattributed orders are excluded. The UI uses “Attributed orders” in explanatory text and tooltips so account totals are not mistaken for all store orders.

## Query and API shape

A shop-scoped, security-invoker database function calculates campaign metrics at request time for the selected allowlisted window. It returns one row per campaign plus the classification fields and these values:

- `orders`
- `revenue_cents`
- `spend_cents`
- `profit_cents`
- `true_roas`
- `cost_complete`
- `cost_sources`

The existing authenticated Campaigns loader validates the window, calls this function, resolves the current campaign score, and returns one combined DTO. The client aggregates the four account cards from the unfiltered DTO list and filters table rows locally.

The existing authenticated campaign write route accepts classification changes. It uses `requireDashboardSession`, `requireSameOrigin`, strict boundary validation, and the session shop id. The client never supplies a tenant id.

## Failure behavior

- Unsupported windows return `400`; they never fall through to arbitrary SQL intervals.
- Invalid campaign kinds, missing Sales types, or oversized custom labels return `400`.
- A campaign outside the current shop returns `404`.
- A metrics-query failure produces the dashboard's visible retry/error state; the API never substitutes zero metrics.
- No attributed orders produces real zero order/revenue values.
- No spend produces `true_roas = null`, not `0`.
- Incomplete cost inputs return a best-known profit with `cost_complete = false`; the UI shows an `Incomplete costs` marker and source detail.
- Legacy drafts without classification parse successfully as Regular.

## Testing

### Database and server

- Name-detector precedence, case handling, conservative Regular fallback, backfill, insert behavior, and merchant-override preservation.
- The metric function for 7/30/90-day boundaries, distinct order counts, tenant isolation, refunds, zero spend, and unattributed-order exclusion.
- Profit math with QuickBooks cost, catalog fallback, missing COGS, missing carrier cost, and estimated payment fees.
- Loader authentication and window validation.
- Classification-write authentication, same-origin enforcement, boundary validation, tenant scoping, and Regular clearing `sale_type`.

### Client

- All / Sales / Regular changes table membership only.
- Account cards remain based on all campaigns.
- Date changes refresh both cards and row values and persist the selection.
- Zero-spend ROAS and incomplete-profit states render honestly.
- The wizard requires a sale type, persists it through draft/resume, and includes it on review/create.

### Manual verification

- Open Campaigns with a mixed account and verify All, Sales, and Regular membership.
- Switch 7 / 30 / 90 days and compare card and row changes.
- Edit an auto-detected campaign, refresh/sync, and confirm the merchant override remains.
- Create a paused Black Friday campaign through all five wizard steps and verify its classification after refresh.
- Verify narrow-screen horizontal table behavior and accessible segmented-control semantics.

## Delivery

Implementation happens in the isolated `feat/campaign-sales-profit-metrics` worktree. The database migration and application changes ship in one pull request. The migration must be applied before code that requests the new function is promoted. No campaign is activated during verification.
