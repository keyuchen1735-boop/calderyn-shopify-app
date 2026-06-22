# Handoff: write_products scope for discontinue_sku (Phase 2)

## What changed
`shopify.app.calderynextension.toml` adds `write_products` to access_scopes.

## Why
The `discontinue_sku` remediation executor archives a money-losing product on
Shopify via the `productUpdate` Admin GraphQL mutation (`ProductStatus.ARCHIVED`),
and re-activates it on undo. Both require `write_products`. `read_products` (already
held) is insufficient for the write.

## Merchant impact — scope re-grant
Adding a scope forces a **re-authorization**: existing installs must re-consent on
next load (Shopify shows the updated permission screen). The embedded app already
handles the standard OAuth re-grant via `@shopify/shopify-app-remix`; no extra code.
Until a merchant re-grants, `productUpdate` calls 403 — the executor surfaces this as
a failed audit row + error toast (rule 12), never a silent no-op. **Action item:** flag
this in release notes so support expects the one-time re-consent prompt.

## App Store review note (paste into the submission)
> Calderyn requests `write_products` to let merchants discontinue an unprofitable
> product directly from a money-loss alert. The app archives the product
> (`productUpdate` → ARCHIVED), which is fully reversible from the in-app audit log
> (one-click undo re-activates it). The app never deletes products. The write is only
> triggered by an explicit merchant action (or, in a later release, autopilot within
> merchant-set guardrails) on a product the app has flagged as losing money.

## Verify
`shopify app config push` (or the deploy pipeline) propagates the scope change to the
Partner dashboard. Confirm the live app's "API access" lists write_products before
shipping the executor.
