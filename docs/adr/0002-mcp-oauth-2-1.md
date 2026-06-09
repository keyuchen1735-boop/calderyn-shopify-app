# ADR 0002: Native Claude.ai connector via OAuth 2.1 (with bearer kept as escape hatch)

**Status:** Accepted — 2026-06-08
**Spec:** `docs/superpowers/specs/2026-06-08-claude-connector-oauth-design.md`
**Supersedes/extends:** [ADR 0001](0001-mcp-server-split.md) v2 stub.

## Context

The 2026-05-25 spec deferred OAuth 2.1 to a v2 workstream. v1 shipped a bearer-token paste flow that few merchants will complete (copy a long string from one tab, paste into Claude.ai's connector dialog). Anthropic's MCP connector UX expects discoverable OAuth + dynamic client registration; without it, "Add connector" looks broken in Claude.ai.

## Decision

**Implement OAuth 2.1 (authorization code + PKCE + DCR + refresh rotation) across both repos, with the authorize/token/register endpoints in `shopify-app` and a single well-known resource doc in `calderyn-mcp`. Keep the bearer-token flow at `/app/mcp` as an escape hatch for custom MCP clients.**

Specifically:
- The four OAuth endpoints live in `shopify-app` because the Shopify offline session — the only authoritative shop-identity source — lives there. Putting `/oauth/authorize` anywhere else requires a cross-repo redirect dance that adds two hops with no upside.
- Dynamic Client Registration (RFC 7591) is open; clients are public (`token_endpoint_auth_method: "none"`), with PKCE S256 as the security boundary. Claude.ai is a public client; this matches the connector spec.
- Refresh tokens rotate on use. Replay of a stolen refresh produces a detectable failure on the next legitimate use.
- The `mcp_tokens` table is extended (`auth_type`, `client_id`, `expires_at`, `refresh_hash`) rather than duplicated. The introspection middleware in `calderyn-mcp` already keys on `token_hash`; adding one `expires_at IS NULL OR expires_at > now()` predicate is the entire functional change on the server side.
- Bearer-token flow remains. Two auth modes → one `{shop_id, scopes}` context → tool handlers don't distinguish.

## Consequences

**Positive.**
- Merchants get a one-click connector flow.
- The bulk of the OAuth machinery is colocated with the Shopify session, where it's easy to reason about.
- The bearer flow stays available for power users and custom agents.

**Negative.**
- Two repos to coordinate during a single OAuth release (small — only one route + one middleware change in `calderyn-mcp`).
- DCR is an open endpoint, so it gets a basic IP rate limit. Worth it for the connector UX.
- The "which shop?" prompt at `/oauth/authorize` is a small UX wart when the merchant arrives with no Shopify session. Acceptable for v1; can be smoothed later.

## Alternatives considered

- **Static client registration (no DCR).** Rejected: requires pre-provisioning a `client_id` for Claude.ai, and the connector UX expects DCR. Locks out other agents.
- **`/oauth/authorize` in `calderyn-mcp`, redirect to `shopify-app` for consent then back.** Rejected: two extra hops, two domains in the URL bar mid-auth, harder to debug.
- **OAuth replaces the bearer flow entirely.** Rejected per user choice — bearer stays for custom MCP clients.
