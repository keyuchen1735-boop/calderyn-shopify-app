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
- **Secret storage:** put all secrets and client IDs (Shopify API key/secret, OAuth client IDs, tokens) in `.env.local` only — never `.env`, never source. Ensure `.env.local` is listed in `.gitignore` and never committed.

## Best practices (Karpathy contract applies, plus repo-specific)
- Loaders are read-only; mutations go in actions. Return `redirect()` after successful actions to avoid double-submit.
- Validate inbound form data at the action boundary — do not trust `FormData` shapes.
- Surface every Shopify API error with `response.errors` checked; do not swallow GraphQL `userErrors`.
- Idempotent webhook handlers — Shopify retries. Key off `X-Shopify-Webhook-Id` if dedup is needed.
- No new top-level dependencies without flagging the tradeoff (bundle size, license, maintenance).
- Match existing file layout (`app/components`, `app/lib`, `app/routes`). New shared logic goes in `app/lib/`, not inline in routes.

## Dashboard parity (MANDATORY for every feature change)
Calderyn ships on two surfaces: this Shopify extension and the **Calderyn dashboard** (a separate, already-built monorepo on its own stack — raw `postgres`/`withShopContext`, `apps/web`, its own non-Polaris UI). They share the same product brain, so any feature change here MUST be reflected in the dashboard too.

- **Scope:** new routes, new merchant-facing behavior, schema changes that surface in UI, detector/label changes, new actions. Pure infra/internal edits (auth glue, webhook plumbing not visible to users) are exempt.
- **Mirror, don't redesign or port.** The dashboard's UI already exists — slot the feature into its existing patterns/components. Do NOT copy Polaris JSX; translate the feature's behavior + data contract into the dashboard's own primitives. The repos diverge at the DB layer, so the dashboard side is a re-implementation against its own stack — **match the contract, not the code.**
- Treat the dashboard mirror as part of the same task, not a follow-up. If only one side can ship in a given change, say so explicitly and leave a TODO for the dashboard side — never silently ship single-sided.

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
- **Auto-commit completed features.** Once a feature is done and verified, commit it without waiting to be asked — but only after the Pre-commit gate above is fully green (every step run, results shown). The gate is a hard precondition; never auto-commit past a failing or skipped check (rule 12). If on the default branch, branch first. Do not push or open a PR automatically — that still waits for an explicit request.

## Tool use
- **Always prefer available MCP/CLI tools over manual work or guessing.** Before doing a task by hand (shell scripting, reading files ad hoc, recalling API shapes), check whether an MCP server or CLI listed below covers it and use that. Asking me whether a tool exists is a last resort — discover it yourself first (e.g. `which <cli>`, the MCP/CLI lists below, `codegraph_status`). Only ask if discovery is inconclusive or the tool needs credentials/permission you can't supply.

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

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
