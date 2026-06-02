# Project: calderyn (Shopify Embedded App)

## Stack
- **Runtime:** Node.js 18.20 / 20.10 / 21+, ES modules (`"type": "module"`).
- **Framework:** Remix (Vite) + `@shopify/shopify-app-remix` for OAuth, webhooks, session.
- **UI:** React 18 + Shopify Polaris + App Bridge React (embedded admin).
- **Data:** Prisma ORM against SQLite (`prisma/dev.sqlite`) in dev; session storage via `@shopify/shopify-app-session-storage-prisma`.
- **Tooling:** TypeScript (strict), ESLint (`@remix-run/eslint-config`), Prettier, GraphQL codegen.

## Language & style
- **TypeScript only** for app code. No `any` without a written justification; prefer `unknown` + narrowing. Treat `tsc --noEmit` as authoritative.
- **Server vs client split:** files ending `.server.ts(x)` are server-only; never import them from a client module. Mirror with `.client.ts(x)` when needed.
- **Routes:** filesystem routes under `app/routes/` using `@remix-run/fs-routes` conventions. Loaders/actions return typed `json()` responses; never leak Prisma models — shape DTOs.
- **Shopify auth:** every admin route must call `authenticate.admin(request)` from `app/shopify.server.ts` before any data access. Webhooks go through `authenticate.webhook`.
- **GraphQL:** use the Admin client from the authenticated session. Run `graphql-codegen` after editing `.graphql` files; do not hand-edit generated types.
- **UI:** compose with Polaris primitives. No raw CSS frameworks. App Bridge for navigation, toasts, modals — not `window.*`.
- **DB:** all schema changes go through `prisma migrate dev`; never edit `migrations/` by hand. Wrap multi-step writes in `prisma.$transaction`.
- **Secrets:** read from `process.env` server-side only. Never reference env in client bundles. Update `.env.example` when adding a key.

## Best practices (Karpathy contract applies, plus repo-specific)
- Loaders are read-only; mutations go in actions. Return `redirect()` after successful actions to avoid double-submit.
- Validate inbound form data at the action boundary — do not trust `FormData` shapes.
- Surface every Shopify API error with `response.errors` checked; do not swallow GraphQL `userErrors`.
- Idempotent webhook handlers — Shopify retries. Key off `X-Shopify-Webhook-Id` if dedup is needed.
- No new top-level dependencies without flagging the tradeoff (bundle size, license, maintenance).
- Match existing file layout (`app/components`, `app/lib`, `app/routes`). New shared logic goes in `app/lib/`, not inline in routes.

## Pre-commit gate (MANDATORY for any major commit)
A "major commit" = anything beyond a typo/comment/doc nit: route changes, schema changes, dependency bumps, auth/webhook edits, Polaris/UI components, anything in `app/lib/` or `app/shopify.server.ts`.

**Do not commit, push, or open a PR until all of the following are green. Run them in this order and paste the result, do not assert success without evidence (rule 12).**

1. `/code-review` — run the slash command on the working tree. Resolve every blocker; downgrade nits explicitly with a one-line justification.
2. **Patch sanity** — `git diff --stat` and `git diff --check` clean; no stray `console.log`, `.only`, `TODO(me)`, or commented-out blocks introduced in the diff.
3. **Eval pipeline** — in this repo that means, in order:
   - `npm run typecheck` → exit 0
   - `npm run lint` → exit 0 (no warnings on touched files; `--max-warnings=0` for new code)
   - `npm run build` → exit 0 (Remix + Vite build completes)
   - `npx prisma validate` if `prisma/schema.prisma` changed; `npx prisma migrate diff --exit-code` if migrations changed
   - `npm run graphql-codegen` if any `.graphql` or Admin query changed — commit the regenerated types

If any step fails: **stop, surface the failure, fix the root cause.** Do not `--no-verify`, do not skip with `// eslint-disable`, do not narrow types to silence `tsc`. Per rule 12, never report success when a step was bypassed.

## Commit hygiene
- One logical change per commit. Reference the route/module touched in the subject (e.g. `routes/app._index: fix loader error path`).
- Never commit `.env`, `prisma/dev.sqlite`, or anything under `.shopify/`.

## MCPs
supabase, vercel, gmail, gcal, gdrive, playwright, codegraph.

## CLIs
shopify, vercel, prisma, remix, vite, eslint, tsc, graphql-codegen, gh, git, npm, brew, curl, codegraph.

## CodeGraph (MCP)
Tree-sitter AST index of every symbol/edge/file (`.codegraph/`). Prefer it for **structural** questions; use grep only for literal text. Trust results — don't re-verify with grep. Index debounces ~500ms behind writes.

| Q | Tool |
|---|---|
| Where is X / find symbol | `codegraph_search` |
| What calls Y / what does Y call | `codegraph_callers` / `codegraph_callees` |
| Path from X to Y (bridges dynamic hops) | `codegraph_trace` |
| What breaks if Z changes | `codegraph_impact` |
| Y's signature/source | `codegraph_node` |
| Focused context for a task | `codegraph_context` |
| Several symbols' source at once | `codegraph_explore` |
| Files under path / index health | `codegraph_files` / `codegraph_status` |

Answer architecture Qs directly with 2–3 calls (`context` → one `explore`); for flows use `trace` → one `explore`. Don't chain `search`+`node` (use `context`) or loop `node` (use `explore`). If MCP says "not initialized," ask user to run `codegraph init -i`.
