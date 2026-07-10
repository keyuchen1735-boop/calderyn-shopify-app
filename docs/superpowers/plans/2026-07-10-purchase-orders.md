# Purchase-order subsystem — implementation plan (2026-07-10)

Spec: `docs/superpowers/specs/2026-07-10-purchase-orders-design.md`
Branch: `feat/purchase-orders` (worktree `C:\Users\famou\Desktop\calderyn-purchase-orders`)

Steps (one commit each, gate at the end):

1. **Migration** — `supabase/migrations/20260710200000_purchase_orders.sql`: `supplier_dim`,
   `purchase_order`, `purchase_order_line` (+ indexes, RLS policies copying the shop-scope pattern
   from `20260629160000_inventory_tables.sql`), functions `po_mark_ordered`, `po_receive`,
   `po_cancel` (style of `20260629160150_inventory_merchant_fns.sql`), partial unique index on
   `purchase_order(audit_id)`.
2. **Server lib** — `app/lib/po/suppliers.server.ts`, `app/lib/po/purchase-orders.server.ts`
   (list/get/create/updateDraft/markOrdered/receiveLines/cancel/promoteAuditDraft, po_number
   generator, ETA-from-lead-time, vendor snapshot, projectLevelFact re-projection after
   ordered/receive/cancel). Unit tests.
3. **API routes** — `dashboard.api.po._index.tsx`, `dashboard.api.po.$id.tsx`,
   `dashboard.api.po.suppliers.tsx`, `dashboard.api.po.$id[.]pdf.tsx` (map real PO → PoDraft shape
   for `renderPoPdf`). Transfer-route conventions: `requireDashboardSession`, `requireSameOrigin`
   on POST, `dashboardJson`, `jsonOk`/`jsonError`, intent switch, named 422 codes.
4. **Client module** — `app/lib/dashboard/po-client.ts` (VMs + fetchers + mutations); screen-cache
   key `SCREEN_CACHE_KEYS.po` + `WARM_TARGETS` entry in `prefetch.ts`.
5. **Screen** — rewrite `PurchaseOrders.tsx`: PO table + status badges + detail drawer
   (receive flow) + New-PO modal (variant picker reusing the transfer-picker pattern) + Suppliers
   modal + Autopilot-drafts section with Convert-to-PO. Mobile 390px: wide tables pan inside their
   card (existing Pan primitive), modals/drawers stack.
6. **Gate** — `npm run typecheck`, `npm run lint`, `npm run build` (verify-client-bundle),
   `npx vitest run`. /code-review 8-angle on the diff; fix everything real.
7. **Prod migration + live verify** — apply migration via supabase MCP (slug-diff check first),
   run local dev server against prod Supabase, browser e2e: create supplier → create PO (ETA
   defaulted) → mark ordered (incoming visible) → partial receive → full receive (on_hand up,
   ledger rows) → cancel path on a second PO → promote an Autopilot draft → PDF download → 390px
   pass → zero console errors.
8. **Merge** — rebase onto latest `origin/main` immediately before push; PR; manual merge (fork CI
   is ignored by standing rule); remove worktree.
