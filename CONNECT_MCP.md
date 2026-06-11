# Connect to the Calderyn MCP server

Calderyn exposes a read-only MCP server so an MCP client (Claude.ai, Claude Code,
Claude Desktop, custom agents) can query your shop's alerts, audit log,
campaigns, SKUs, guardrails, ROAS series, and integration status, plus the
`propose_action` tool.

- **MCP endpoint:** `https://calderyn-mcp.vercel.app/mcp`
- **Two ways to connect**, depending on your client:
  - **Claude.ai (web)** → OAuth, no tokens. *Recommended.*
  - **Claude Code / Desktop / custom clients** → `mcp_live_*` bearer token.

There is nothing to paste into Claude.ai — it uses OAuth. Tokens are only for
clients that don't speak OAuth.

---

## A. Claude.ai (web) — OAuth, recommended

Requires a Claude **Pro / Team / Enterprise** plan (free Claude can't add
connectors).

1. In Claude.ai: **Settings → Connectors → Add custom connector**.
2. Name it `Calderyn` and paste the URL: `https://calderyn-mcp.vercel.app/mcp`.
3. Claude.ai discovers the OAuth server and opens a Calderyn consent screen on
   `app.calderyncompany.com`.
   - If you're not already signed into your shop in that browser, you'll be
     asked **"Which shop?"** → enter `your-store.myshopify.com` → sign in through
     Shopify.
4. On **"Connect Claude.ai to {your shop}"**, click **Allow**.
5. Done — Claude.ai is connected. Access is refreshed automatically; you never
   handle a token.

**Manage / disconnect:** in the Calderyn app, open **Claude connections**
(`/app/mcp`). The *Connected Claude.ai workspaces* card lists each connection
with a **Disconnect** button; disconnecting makes the next request from that
workspace fail immediately.

## B. Claude Code / Desktop / custom clients — bearer token

For clients that don't speak OAuth.

1. In the Calderyn app, open **Claude connections** (`/app/mcp`) → the
   *Connect via bearer token (advanced)* card → **Generate token**, name it, and
   **Copy** it. It's shown once (Calderyn stores only a hash).
2. Add it to your client. For Claude Code:
   ```bash
   claude mcp add --scope user --transport http calderyn https://calderyn-mcp.vercel.app/mcp \
     --header "Authorization: Bearer mcp_live_YOUR_TOKEN_HERE"
   ```
3. Verify: `claude mcp list` → `calderyn` shows `✔ Connected` (or `/mcp` in a
   session).

Tokens are read-only and scoped to one shop — mint one per device. Lost or
leaked? Revoke it on the **Claude connections** page; the server rejects it
immediately.

---

## How auth works (reference)

- **OAuth** (Claude.ai): the authorization server lives in the Shopify app
  (`app.calderyncompany.com/oauth/*`) where your shop session lives; the MCP
  server (`calderyn-mcp`) is the resource server that validates the issued
  access token. PKCE-secured, public client, refresh-token rotation.
- **Bearer** (`mcp_live_*`): hashed at rest (HMAC-SHA256), resolved to a
  `shop_id` by the same middleware. Both auth modes land on the same read-only
  data surface.
