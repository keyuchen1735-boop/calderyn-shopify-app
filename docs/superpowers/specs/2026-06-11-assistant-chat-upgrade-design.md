# Ask Calderyn chat upgrade — formatted UI + in-chat actions + dashboard chat

Date: 2026-06-11 · Branch: `feat/assistant-chat` · Status: approved-by-default (autonomous session; decisions anchored in existing patterns, flagged in summary)

## Goal

1. The embedded "Ask Calderyn" slideout renders formatted (markdown) replies instead of plain text, and can **suggest and execute actions** (flag alerts, pause campaigns, snooze, etc.) with the merchant confirming in-chat.
2. The merchant web dashboard (calderyncompany.com/dashboard → `dashboard.*` routes in this repo) gets the same assistant with a polished chat panel built from the dashboard's own `cd-*` design system.

## Non-goals

- No autonomous execution of money-touching actions. The merchant always confirms; only `flag_alert` (acknowledge — a harmless, auditable status change) executes directly on request.
- No streaming (the loop is a non-streaming tool loop today; unchanged).
- No new top-level dependencies. Markdown is a small in-house subset parser (~`react-markdown` would add ~50KB to the embedded admin bundle for model-generated content we control; rejected).

## Architecture

### 1. Shared markdown subset (`app/lib/markdown.ts`, client-safe)

`parseMarkdown(src): MdBlock[]` supporting exactly what the assistant needs:
- Blocks: paragraphs, headings (#–###), unordered/ordered lists, fenced code blocks.
- Inline: `**bold**`, `*italic*`, `` `code` ``, `[text](https://…)` (http/https only).
- XSS-safe by construction: no raw HTML pass-through; everything renders as React text nodes.

`app/components/Markdown.tsx` renders the tree as semantic HTML under a `.calderyn-md` wrapper — no Polaris dependency, so one renderer serves both surfaces; each surface styles `.calderyn-md` in its own CSS.

### 2. Extension slideout (`app/components/Assistant/`)

- Assistant bubbles render `<Markdown>`; user bubbles stay plain text.
- Empty state gains suggested-prompt chips; bubbles restyled (assistant full-width, user tinted right-aligned).
- `DraftActionCard` gains in-chat execution:
  - **Inline-executable kinds** (`pause_campaign`, `reduce_campaign_budget`, `snooze_alert`, `exclude_geo`, `reallocate_inventory`): Run → inline confirm step → `fetcher.submit` POST to the existing `/app/alerts/$id` action (which already enforces detector allowlist, guardrails, idempotency, audit). Card shows running/done/error states; no duplication of security-sensitive code.
  - **Review kinds** (`create_po_draft`, `reallocate_budget` — they need extra inputs): keep the "Review & confirm" deep link.
- New tool `flag_alert(alert_id)` in `tools.server.ts`: acknowledges the alert via an injected callback (`acknowledgeAlert`) — executes directly, reported in the reply. Dispatcher signature becomes `makeToolDispatcher(client, deps)`.
- `prompt.server.ts` updated: markdown formatting contract, in-chat confirm semantics, flag_alert usage rules.

### 3. Dashboard chat

- `app/routes/dashboard.api.assistant.tsx`: GET history / POST one turn (JSON body), `requireDashboardSession` + `requireSameOrigin`, reusing the same `app/lib/assistant/*` brain and conversation store (keyed by shop — history is shared across surfaces by design: one shop, one assistant).
- `app/lib/dashboard/client.ts`: `fetchAssistantHistory()`, `sendAssistantMessage()` (+ ChatMessage VM passthrough).
- `app/components/dashboard/AssistantPanel.tsx`: floating launcher button (bottom-right) + glass slide-over panel: markdown messages, thinking shimmer, suggested prompts, composer (Enter sends). Drafted-action cards reuse `app.executeAction(alertVM, kind)` from `DashboardCtx` for inline kinds (resolves the `AlertVM` from `app.alerts`, falling back to `client.fetchAlert`); review kinds navigate to the Alerts screen.
- New `cd-chat-*` + `.calderyn-md` styles in `app/styles/dashboard.css`; mounted in `DashboardApp` beside `ToastHost`.

### 4. Error handling

Existing patterns preserved: CalderynError → `{code,message}` JSON; failed sends roll back the optimistic user turn; executed-action failures surface the server's toast/message — nothing swallowed.

### 5. Testing

- `app/lib/__tests__/markdown.test.ts`: parser behavior (headings, lists, inline, code fences, link scheme filtering, malformed input).
- Assistant tests: `flag_alert` dispatch (success, missing alert, callback failure) extends existing tool-dispatcher tests.
- Existing suites must stay green; gate per CLAUDE.md (typecheck, lint, build, vitest, /code-review).

## Dashboard parity note

Both surfaces live in this repo; this change ships them together (extension slideout + web dashboard panel), satisfying the parity rule with no external repo work.
