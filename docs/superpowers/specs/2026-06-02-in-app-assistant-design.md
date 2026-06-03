# Design: In-app AI Assistant over Calderyn data

**Date:** 2026-06-02
**Status:** Approved for implementation planning
**Repo affected:** `shopify-app` (calderyn)
**Feature:** #8 — embedded chat assistant

---

## 1. Goal

An embedded chat assistant inside the Shopify admin app that answers a merchant's
questions about their own Calderyn data in plain language — "why did profit drop
last week?", "which campaign is bleeding money?", "what should I do about SKU-123?"
— by reading the same alerts / audit / campaigns / SKUs / guardrails / integrations
data the app already surfaces and explaining it conversationally.

v1 is **read + explain + draft-an-action-to-confirm**. The assistant can *propose*
an action that maps to an existing alert, but it never executes one: the actual
execution always flows through the app's existing confirm modal and its guardrails.

## 2. Resolved decisions (from brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | Read seam | **A — direct `calderynClient(shop)`** server-side (no MCP hop, no token plumbing) |
| 2 | v1 scope | **Explain + draft action to confirm** (deep-link to existing modal; no new execute path) |
| 3 | Placement | **Global slideout** mounted once in the `app.tsx` layout, present on every `/app/*` page |
| 4 | Memory | **Persistent across sessions** — two new additive Supabase tables |
| 5 | Data strategy | **Hybrid** — cached shop snapshot in the system prompt + live tools for drill-down |
| 6 | Model | **Sonnet 4.6** (`claude-sonnet-4-6`), prompt caching, max-turns cap |
| 7 | Turn delivery | **Sync request/response** (whole tool-use loop runs server-side per turn) |

## 3. Non-goals (v1)

- Streaming token-by-token responses (clean later upgrade; loop is already server-side).
- Executing actions from chat — always hands off to the existing `ExecuteActionModal`.
- Any action not tied to a real alert; no parallel "what should I do" recommender
  (the assistant explains #4's alerts/actions — `claude_rank`, `dollar_impact`,
  narrative — it does not reinvent ranking).
- Per-shop rate limiting / daily message cap (deferred; easy to add later).
- Row-Level Security on the new tables (code-scoped for now, consistent with the
  rest of the schema; RLS is a separate pass).
- Sharing / multi-user / presence on conversations.
- Surfacing engagement metrics (likes/comments/shares) — these do not exist in the
  data model today. If session #2 surfaces them through `calderynClient`, the
  assistant gets them "for free" with no design change.

## 4. Architecture

Everything runs server-side; the `ANTHROPIC_API_KEY` never reaches the browser.
The slideout is a thin client that POSTs to one authenticated resource route,
which runs the entire Claude tool-use loop against `calderynClient(shop)`.

```
┌─ Shopify Admin (iframe) ──────────────────────────────┐
│  app.tsx layout                                       │
│   ├─ <Outlet/>  (Alerts, Audit, Campaigns, … pages)   │
│   └─ <AssistantSlideout/>  ← mounted once, every page │
│        • launcher button                              │
│        • message list (Polaris)                       │
│        • composer + drafted-action cards              │
│                 │ fetcher POST / GET                   │
└─────────────────┼─────────────────────────────────────┘
                  ▼
        app/routes/app.assistant.tsx   (resource route, authenticate.admin)
                  │  loader = load history    action = run one turn
                  ▼
        app/lib/assistant/loop.server.ts  ── the tool-use loop
            │            │              │
            ▼            ▼              ▼
   anthropic.server   tools.server   conversations.server
   (Sonnet 4.6,       (defs +        (Supabase read/write
    prompt cache)      dispatch →     chat history)
                       calderynClient)
                  │
                  ▼
        calderynClient(shop)  → Supabase (existing read seam)
```

### 4.1 File map

| File | New/Edit | Purpose |
|---|---|---|
| `app/routes/app.assistant.tsx` | new | Resource route: `loader` returns history; `action` runs one turn. `authenticate.admin` first. |
| `app/lib/assistant/loop.server.ts` | new | Orchestrates the Claude ↔ tools loop; max-turns cap |
| `app/lib/assistant/tools.server.ts` | new | Tool schemas + dispatch into `calderynClient` |
| `app/lib/assistant/snapshot.server.ts` | new | Builds the cached shop snapshot (counts + top alerts) |
| `app/lib/assistant/prompt.server.ts` | new | System prompt with `cache_control` blocks |
| `app/lib/assistant/conversations.server.ts` | new | Supabase CRUD for conversations/messages (shop-scoped) |
| `app/lib/assistant/anthropic.server.ts` | new | Anthropic SDK client singleton |
| `app/lib/assistant/types.ts` | new | Chat message + drafted-action DTOs |
| `app/components/Assistant/AssistantSlideout.tsx` | new | The panel UI (Polaris content) |
| `app/components/Assistant/*` | new | Launcher, message bubble, drafted-action card |
| `app/components/Assistant/assistant.css` | new | Component-scoped positioning for launcher + panel only |
| `app/routes/app.tsx` | edit | Mount `<AssistantSlideout/>` in the layout |
| `app/routes/app.alerts.$id.tsx` | edit | On mount, read `?action=` and pre-open `ExecuteActionModal` |
| `supabase/migrations/<ts>_assistant.sql` | new | Two additive tables |
| `.env.example` | edit | Add `ANTHROPIC_API_KEY` |
| `package.json` | edit | Add `@anthropic-ai/sdk` dependency |

## 5. Turn lifecycle

One turn, synchronous:

1. Slideout `useFetcher()` POSTs `{ conversationId?, message }` to `app.assistant.tsx`.
2. `authenticate.admin(request)` → `shop`. Validate input (non-empty, length cap,
   and that `conversationId` — if present — belongs to this shop). Load-or-create
   conversation; append the user message to `assistant_messages`.
3. Build the Anthropic request:
   - **System prompt** = static instructions + tool guidance + vocabulary (what the
     detectors mean, that `claude_rank` is #4's priority order, that `dollar_impact`
     and other money fields are in **cents** and must be rendered as dollars, what
     each `ActionKind` does) → **cached block**; followed by the **shop snapshot**
     (counts + top-ranked open alerts) as a separate volatile block.
   - **Messages** = prior visible history (last ~20) + the new user message.
   - **Tools** = the read + propose set (§6).
4. **Loop** (`loop.server.ts`): call Sonnet 4.6. While `stop_reason: "tool_use"`,
   dispatch each tool via `calderynClient(shop)` (or `propose_action` validation),
   append `tool_result`, and call again. Stop on a normal text reply **or** when the
   max-turns cap (8 tool round-trips) is reached.
5. Persist the final assistant message (visible text + any `drafted_action`).
6. Return `{ conversationId, assistantMessage, draftedAction? }` to the slideout.

## 6. Tool surface

All read tools dispatch into the existing `calderynClient` — no new data paths.
Outputs are the existing DTOs (already shaped; no Prisma leakage).

| Tool | Maps to | Inputs |
|---|---|---|
| `list_alerts` | `alerts.list(filters)` | `status?`, `severity?`, `detector_id?`, `limit?` (cap 200, default 50) |
| `get_alert` | `alerts.get(id)` | `id` |
| `list_audit` | `audit.list()` | `limit?` |
| `list_campaigns` | `campaigns.list()` | `status?` (`active`/`paused`, filtered in-tool) |
| `list_skus` | `skus.list()` | `low_cover_only?` (filtered in-tool) |
| `get_guardrails` | `guardrails.get()` | — |
| `list_integrations` | `integrations.list()` | — |
| `propose_action` | validation only (§7) | `alert_id`, `action_kind` |

Each read tool carries a multi-sentence description telling Claude when to call it
and how to interpret the output. The `limit` cap (200) keeps context manageable.

## 7. Drafted-action handoff

The assistant can *propose* an action but never executes one. It hands off to the
existing confirm modal, which owns every guardrail.

**`propose_action(alert_id, action_kind)` — validated in the loop:**

1. Confirm the alert exists (`alerts.get`). If not → tool error (`isError`) → Claude
   explains it can't.
2. Confirm `action_kind ∈ DETECTOR_TO_ACTIONS[alert.detector_id]` (the same
   allowed-set the alert page uses). If not → tool error.
3. On success: the loop attaches a structured
   `draftedAction { alertId, actionKind, label, dollarImpact }` to the turn, and the
   `tool_result` feeds Claude the alert title / action label / dollar impact /
   guardrail snapshot so it can phrase the message.

**In the slideout**, the turn renders a Polaris card under Claude's reply:

```
Proposed: Pause "Summer-Meta"   $1,234 / 30d   [ Review & confirm ]
```

**[Review & confirm]** → Remix `useNavigate` to `/app/alerts/{alertId}?action={actionKind}`.

**Edit to `app.alerts.$id.tsx`:** on mount, read `?action=`; if the value is in the
page's `allowedActions`, pre-open the existing `ExecuteActionModal` with that kind
(today the modal is opened by `setActionKind`; we add a `useEffect` that reads the
search param once). Invalid/absent values are ignored. From there it is the
**unchanged** execution path — guardrails, idempotency, Shopify/Meta calls, Undo.
The assistant is fully out of the execution path.

**Deliberate constraint:** actions are alert-scoped today, so the assistant can only
propose an action that maps to a real alert. Asked to "pause Campaign X" with no
alert, it explains there is no active alert/action for that and links to Campaigns.
This keeps #4's ranking + guardrails authoritative.

## 8. Persistence schema

Two **new, additive** tables (no edits to existing tables → no collision with the
#2/#4 migrations). Same shop-scoping pattern as `mcp_tokens`.

```sql
create table assistant_conversations (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references shops(id) on delete cascade,
  title       text,                          -- derived from first user msg
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on assistant_conversations (shop_id, updated_at desc);

create table assistant_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references assistant_conversations(id) on delete cascade,
  shop_id         uuid not null references shops(id) on delete cascade,  -- denormalized, scoped reads
  role            text not null check (role in ('user','assistant')),
  content         text not null,             -- visible message text
  drafted_action  jsonb,                     -- {alertId,actionKind,label,dollarImpact} | null
  created_at      timestamptz not null default now()
);
create index on assistant_messages (conversation_id, created_at);
```

**What we store:** only the *visible transcript* — user text, assistant text, and
any drafted-action card. We deliberately do **not** persist raw `tool_use` /
`tool_result` blocks. On each turn we rebuild the Anthropic `messages` array from
this plain history + a fresh snapshot, and let Claude re-pull specifics via tools if
needed. Result: smaller rows, no large tool payloads stored, human-readable history.

**Resume behavior:** the slideout opens the most recent conversation; a "New chat"
button starts another; a light history list (titles) in the panel header switches
between them. `updated_at` is bumped in code on each new message.

**Scoping:** service-role key + mandatory `shop_id` filter in
`conversations.server.ts` (same posture as the MCP design). There is no path that
reads/writes these tables without a `shop_id` derived from `authenticate.admin`.

## 9. The slideout UI

Mounted once in `app.tsx` inside `AppProvider`, alongside `<Outlet/>`, so it is
present on every `/app/*` page.

```
                                   ┌─ Calderyn assistant ──── ⌄ hist  + new  ✕ ┐
                                   │ ┌──────────────────────────────────────┐ │
   page content (Alerts/etc.)      │ │ you: why did profit drop last week?  │ │
                                   │ │ Claude: Two campaigns went below     │ │
                                   │ │ breakeven…                            │ │
                                   │ │ ┌─ Proposed: Pause Summer-Meta ───┐  │ │
                                   │ │ │ $1,234/30d   [ Review & confirm ]│  │ │
                                   │ │ └──────────────────────────────────┘ │ │
                                   │ └──────────────────────────────────────┘ │
                          ╭─────╮  │ [ Ask about your data…        ] [ Send ] │
                          │ 💬  │  └───────────────────────────────────────────┘
                          ╰─────╯   ← launcher (bottom-right, every page)
```

- **Launcher**: floating button, bottom-right. **Panel**: right-side, ~400px wide,
  full height, slides in.
- **Content is all Polaris** — header (`Popover`+`ActionList` history switcher,
  "New chat", close), scrollable message list (`Card`/`Box` bubbles), `Spinner`
  "Claude is thinking…" while the fetcher submits, footer composer (`TextField`
  multiline + `Button`, Enter-to-send), drafted-action `Card`.
- **The one custom bit**: a single component-scoped CSS file positions *only* the
  launcher + panel (fixed/right, slide transition) — Polaris has no drawer
  primitive. No CSS framework, no `window.*`.
- **Data**: a Remix `useFetcher()` POSTs messages and `fetcher.load`s history on
  open. Local React state holds open/closed, `conversationId`, and optimistic
  messages; the server response reconciles.
- **Navigation** to `/app/alerts/{id}?action=…` via Remix `useNavigate`
  (App Bridge-aware) — no raw links, no `window.*`.

## 10. Cost guardrails

- **Model:** Sonnet 4.6 (`claude-sonnet-4-6`).
- **Caching:** `cache_control` on the static system block (instructions + tool
  defs); the volatile snapshot + history are left uncached.
- **Bounds per turn:** max **8** tool round-trips (loop guard); `max_tokens` capped
  (~1.5k); snapshot = counts + top **10** open alerts only; history window = last
  **~20** messages resent (older rows stay in DB, not resent). User message length
  capped at the action boundary.
- Max-turns hit → graceful "I gathered a lot; here's what I have so far" reply.

## 11. Error handling

| Class | When | Behavior |
|---|---|---|
| Anthropic error | rate-limit / 5xx / timeout | Caught in loop → friendly "couldn't reach Claude, retry" to the UI. The user message is already saved; the broken assistant turn is **not** persisted, so retry is clean. Logged server-side. |
| Tool error | `ALERT_NOT_FOUND`, bad filter, invalid `propose_action` | Returned as `tool_result` with `isError: true`; Claude explains gracefully. Mirrors the MCP error taxonomy — `CalderynError.code` is the public contract. |
| Config error | missing `ANTHROPIC_API_KEY` | Action returns 500; slideout shows a Polaris banner. |
| Auth / scope | unauthenticated, cross-shop `conversationId` | `authenticate.admin` rejects; conversation ownership checked before any read/write. |

## 12. Testing

Vitest (already configured). Server-focused, with faked Anthropic + Supabase
clients — no live API calls.

1. `tools.server` — each tool maps to the right `calderynClient` method with
   transformed filters; `propose_action` validation (valid kind / invalid kind /
   missing alert).
2. `loop.server` — text-only turn; `tool_use` → `tool_result` → text; max-turns cap;
   tool error surfaced as `isError`.
3. `conversations.server` — create / append / list; shop-scoping (cannot read
   another shop's conversation); `updated_at` bump.
4. `snapshot.server` — bounded snapshot (counts + capped top alerts) from a faked
   client.
5. `prompt.server` — `cache_control` block placement (static cached, snapshot
   separate and uncached).

UI tests are light/optional (a render check of a message bubble or drafted-action
card), consistent with the repo's server-leaning test posture.

## 13. Dependencies & gate

- **Add `@anthropic-ai/sdk`** — one new top-level dependency. Tradeoff: official,
  MIT-licensed, well-maintained; it is the supported client for tool-use + prompt
  caching. Justified per the "flag new deps" rule in `CLAUDE.md`.
- **`.env.example`** — add `ANTHROPIC_API_KEY` (server-only; never in a client
  bundle).
- **Pre-commit gate** (per `CLAUDE.md`): `/code-review`, patch sanity,
  `npm run typecheck` → `npm run lint` (`--max-warnings=0` on new code) →
  `npm run build`. No Prisma `schema.prisma` change and no `.graphql` change, so
  those gate steps are N/A. The Supabase migration is applied separately
  (additive, two new tables).

## 14. Coordination (two other live sessions)

- **#2 ad-spend analytics** and **#4 constant analysis** are concurrently editing
  `app/lib/types.ts` and `supabase/migrations/`. This feature avoids both hotspots:
  assistant DTOs live in `app/lib/assistant/types.ts` (no `types.ts` edits), and the
  only migration added is the new additive `<ts>_assistant.sql`.
- Shared-file edits are limited to `app/routes/app.tsx` (mount the slideout) and
  `app/routes/app.alerts.$id.tsx` (read `?action=`). Rebase often.
- The assistant's capability == whatever #2/#4 expose through `calderynClient`. New
  data they surface (e.g. engagement metrics, the `reallocate_budget` action) flows
  into the assistant for free once it appears in the DTOs / `DETECTOR_TO_ACTIONS`.

## 15. Definition of done (v1)

- A merchant opens any `/app/*` page → clicks the launcher → asks "why did profit
  drop last week?" → gets a plain-language answer grounded in their own alerts /
  campaigns / SKUs, only their shop's data.
- Follow-up questions work within the conversation; closing and reopening the app
  later restores the conversation (persisted).
- When a real alert supports an action, the assistant can propose it; "Review &
  confirm" deep-links to the existing alert modal and the unchanged guardrail-bound
  execution path.
- The assistant never executes an action and never proposes one without a backing
  alert.
- `ANTHROPIC_API_KEY` is server-only; the key never appears in a client bundle.
- Vitest suite (tools / loop / conversations / snapshot / prompt) is green; the
  pre-commit gate passes.
