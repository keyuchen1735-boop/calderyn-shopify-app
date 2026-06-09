# Connect to the Calderyn MCP server

The Calderyn MCP server gives an MCP client (Claude Code, the Claude.ai
connector, a custom agent) read-only access to your shop's alerts, audit log,
campaigns, SKUs, guardrails, ROAS series, and integration status — plus the
`propose_action` tool.

- **Endpoint:** `https://calderyn-mcp.vercel.app/mcp`
- **Transport:** HTTP
- **Auth:** per-user bearer token of the form `mcp_live_...`

Each user authenticates with **their own** token. A token is scoped to one shop
and is shown exactly once when created — Calderyn stores only a hash.

---

## Step 1 — Generate your token

1. Open the Calderyn app in your Shopify admin.
2. Go to the **MCP tokens** page (route `/app/mcp`).
3. Click **Generate token**, give it a name (e.g. `claude-code-laptop`), and
   click **Generate**.
4. In the reveal modal, click **Copy to clipboard**. **Copy it now — it is not
   shown again.** If you lose it, revoke and regenerate.

## Step 2 — Add it to Claude Code

Paste this command, replacing the token with the one you just copied:

```bash
claude mcp add --scope user --transport http calderyn https://calderyn-mcp.vercel.app/mcp \
  --header "Authorization: Bearer mcp_live_YOUR_TOKEN_HERE"
```

`--scope user` makes it available in every project on your machine (written to
`~/.claude.json`).

## Step 3 — Verify

```bash
claude mcp list        # calderyn should show: ✔ Connected
```

Or run `/mcp` inside a Claude Code session. You're connected.

---

## Managing the connection

```bash
claude mcp get calderyn       # show config + status
claude mcp remove calderyn -s user   # disconnect
```

To rotate a token: generate a new one on `/app/mcp`, re-run the `claude mcp add`
command (it overwrites), then **Revoke** the old token in the app.

## Notes

- Tokens are read-only and shop-scoped — safe to mint one per device.
- Because every user needs a different token, this is **not** distributed via a
  committed `.mcp.json`. Each user runs the `claude mcp add` command above.
- Lost or leaked token? Revoke it on the **MCP tokens** page; the server rejects
  it immediately.
