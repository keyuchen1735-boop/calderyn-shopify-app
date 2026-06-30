# Frictionless Agentic Commerce

**Date:** 2026-06-30
**Status:** shipping

## Decision

Buy-in-chat P2 (merged) gated agentic sales behind two friction points: a per-client `commerce_scope` boolean (default `false`) and a `spend_cap_cents` ceiling (default `0`, interpreted as "no commerce allowed"). Founder decision: **commerce is ON by default** for any connected AI client. The per-client disable/cap remains an optional merchant override — the data columns and guardrail logic still support it — but no merchant setup is required to accept an AI-initiated sale.

Payment via Stripe is unchanged. Every placed order still requires buyer payment at a Stripe-hosted URL before the order is fulfilled. This change removes cap/scope friction, not the charge.

## Three code changes

1. **Migration `20260630160000_frictionless_commerce_defaults.sql`** — flips `mcp_oauth_clients.commerce_scope` default to `true` and back-fills existing rows. `spend_cap_cents = 0` is re-documented as UNLIMITED (no ceiling); a positive value is still a hard per-order cap.

2. **Guardrail semantics (`guardrail.server.ts`)** — `assertWithinCommerceCap` now:
   - Allows commerce when the client row is absent (frictionless — new clients are in by default).
   - Allows commerce when `commerce_scope` is `true` or absent.
   - Throws `CommerceDisabledError` (code `COMMERCE_DISABLED`) only when a merchant has explicitly set `commerce_scope = false` for that client.
   - Throws `SpendCapError` (code `SPEND_CAP_EXCEEDED`) only when `spend_cap_cents > 0` and `amountCents > cap`. Cap of `0` or absent = UNLIMITED.
   - `CommerceNotAuthorizedError` is renamed to `CommerceDisabledError` throughout.

3. **Dispatcher gate (`tools.server.ts`)** — commerce tools are no longer gated by an OAuth scope string. They route whenever `deps.commerceCtx` is present. If a commerce tool is called with no `commerceCtx`, the dispatcher returns `COMMERCE_UNAVAILABLE`. The in-app merchant assistant (no `commerceCtx`) is unaffected. `toolsForScopes` is replaced by `EXTERNAL_TOOLS` (the advertised toolset for external connected clients).

## Spend cap semantics

| `spend_cap_cents` | Meaning |
|---|---|
| `0` (default) | UNLIMITED — no ceiling enforced |
| `> 0` | Hard per-order cap in cents; exceeded orders are refused before charge |

## Deferred: merchant knob UI

The data layer supports per-client disable (`commerce_scope = false`) and a positive cap. No merchant-facing toggle screen ships in this slice. The "Agentic channel" panel (P4) already surfaces clients and orders; a per-client edit UI is a follow-up.

## External follow-up

The `calderyn-mcp` server deploy must pass `commerceCtx` and advertise `EXTERNAL_TOOLS` (the merged toolset). Until that deploy, external clients receive only the assistant tools.

## Dashboard parity

No dashboard change needed. This is a backend authorization-defaults change; the "Agentic channel" panel (P4, `dashboard.api.agentic._index.tsx`) already surfaces clients and orders.
