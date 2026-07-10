# Products area: finish + polish (design)

Date: 2026-07-09
Status: approved scope, pre-implementation
Branch plan: fresh worktree `feat/products-finish` off `origin/main` (current workspace carries unrelated Autopilot WIP; main has the Orders rework this design matches). Spec is committed as the first commit on that branch.

## Goal

Bring every section of the dashboard Products area to a finished, consistent, Shopify-competitive state, with ease-of-use and agentic touches Shopify does not have. No new subsystems: Purchase orders stays an Autopilot-drafts lens, SEO fields and product duplication are out of scope.

## Sections and requirements

### Navigation (revised after main recon)
- On main, Products navigation lives in the sidebar rail (`DashboardApp.tsx` NAV_GROUPS), and its children already include Inventory, Purchase orders, Transfers, Collections, and Locations. No subtab-bar work is needed.
- New requirement instead: `products/collections/<id>` becomes a routable collection-detail URL (`routes.ts` seg/parsePath), reusing the `collections` screen with a param.

### Catalog (`Catalog.tsx`)
- Product thumbnails and variant count in the Product cell. The list API already returns `imageUrl` and `variantCount`; render them (fallback glyph when no image).
- Clear-search (x) affordance on the search box.
- Sortable columns: title, price, updated. Sort state in URL-independent component state is acceptable (matches current filter behavior).
- Bulk actions: row checkboxes + select-all, action bar with Set active / Set draft / Archive / Unarchive (context-aware by current view) and Add to collection (picker). New bulk endpoint `POST /dashboard/api/catalog/products/bulk` with per-row error handling, mirroring the Orders bulk pattern (native-only validation, per-order errors).
- Keep existing cache seeding (`catalogCacheKey`) and write-through.

### Inventory (`Inventory.tsx`)
- Debounced search over SKU/product title.
- Stock-status filter: All / Healthy / Low / Out (reuses existing velocity-based cover status).
- Load-more offset pagination (stop fetching everything).
- New columns: Reserved and Available, backed by a new shop-wide balances read shipped as a SQL RPC (`inventory_list`) so search/filter/pagination happen in one query (PostgREST can't aggregate-with-group client-side; mind the 1000-row clamp).
- The list becomes variant-grained (each row carries `variantId` + `productId`), replacing the `v_skus_flat` read on this screen only (`fetchSkus` stays for other consumers).
- Inline on-hand editing directly in the grid row for single-location variants (blur/Enter commit, optimistic with rollback + toast on error; reuses the per-variant stock write API). Multi-location variants open the drawer instead — an aggregate number can't be edited honestly across locations. [agentic/ease add #1]
- Autopilot presence: Low/Out rows show what Autopilot already did about it (e.g. "Restock draft · 2d ago" linking to the audit row / Purchase orders screen) when a matching restock action exists. Data comes from existing audit/alert records; read-only badge + link, no new engine work. [agentic/ease add #2]
- Row click opens an inline drawer embedding the existing `InventoryPanel` (per-location on-hand, reserved/incoming, move stock, history) with an "Open product" link to the product editor. ("Both" behavior.)
- Keep `inventorySkus` cache seeding; extend the cached shape as needed.

### Purchase orders (`PurchaseOrders.tsx`)
- Stays a lens over Autopilot `create_po_draft` actions, but gets its own dedicated endpoint reading `action_audit` directly (kind-filtered, paginated) with a purpose-built DTO: PO number, first-line SKU, line count, total cents, outcome, and `hasPdf` computed server-side as `params.po` present — the exact predicate the PDF route 404s on.
- Honest framing copy stating exactly what the screen is.
- PDF button renders only when `hasPdf` is true (no more 404-able button).
- Gains its own screen-cache key + WARM_TARGETS entry.

### Transfers (`Transfers.tsx`, `TransferModal.tsx`)
- "New transfer" button on the screen. TransferModal gains a variant-picker first step (searchable) for shop-wide use; existing per-variant invocation from InventoryPanel skips that step.
- "Recently received" section listing completed transfers (last 30 days) from the ledger, so received transfers stop vanishing.
- Honest error handling: refetch failure shows an error state rather than silently keeping stale rows.
- Modal polish: show available stock at the source location; surface (don't swallow) location-fetch errors; reuse the warm `locations` cache seed; focus trap; Escape/backdrop close kept.

### Collections (`Collections.tsx` + API)
- Inline rename, delete with confirm (membership rows detach; products unaffected).
- Product count per collection.
- Click-through to a collection detail view listing member products with add/remove (searchable add picker).
- API grows PUT (rename) and DELETE on `/dashboard/api/catalog/collections/:id`, plus membership list/add/remove endpoints. All writes same-origin + session-scoped.
- Search over collections when the list is long; keep cache seeding.

### Locations (`Locations.tsx` + API)
- Add location (modal or inline form: name, address fields, priority).
- Deactivate (soft delete, since ledger history references locations) with a guard: blocked with a clear message if any variant has on-hand stock there. Deactivated locations disappear from pickers and the list.
- Real loading skeleton and real error state (kill the false "No locations yet" on fetch failure).
- Saves fire only when a field actually changed (dirty check); inputs become controlled.
- API grows POST create and a deactivate write (PUT `active: false` or DELETE mapped to soft-deactivate).

### Product editor (`ProductEditor.tsx`, `InventoryPanel.tsx`)
- Image management: reorder (move up/down), set primary, alt text. The `product_media` table already has `position`, `alt`, and `is_primary` — no migration; the work is media-route intents + surfacing the fields through the client VM and editor UI.
- Compare-at price per variant (needs a `variant_dim.compare_at_price_cents` migration; render strikethrough on the storefront PDP when set and greater than price).
- Cost per item per variant (plumbing already exists end-to-end as `unitCostCents`; expose it in the editor).
- Expose the inventory-tracked toggle (plumbing exists as `inventoryTracked`; expose it per variant).
- InventoryPanel fixes: `reload()` errors surfaced (no more silent stale data), skeleton loading, controlled inputs that don't desync after reload, "No stock locations yet" links to Locations, history gains "view all".

### New product flow (`NewProductFlow.tsx`)
- Multi-photo upload at create (currently single). First photo is primary; same type/size validation.

### Cross-cutting polish
- Every silent `.catch(() => {})` in the area is removed and surfaced (InventoryPanel reload, TransferModal locations, NewProductFlow collections, Locations load).
- Consistent skeleton / empty / error states across all six sections.
- Mobile pass on tables, drawer, and panels.
- Apply `design-taste-frontend` + `emil-design-eng` for the visual work; `cd-*` primitives only, Lucide icons via CDIcon.
- Screen-cache: all existing seeds kept; PO gains a key; new data shapes stay cache-compatible.

## Out of scope (explicit)
- Real purchase-order subsystem (suppliers, ETA, status, receive flow).
- SEO fields (handle, meta title/description) anywhere.
- Product duplication, gift cards, bulk "Fix with AI" (deferred to follow-up).

## Architecture notes
- All new/changed API routes follow the existing pattern: `requireDashboardSession`, `requireSameOrigin` on writes, `dashboardJson` DTOs, tenant from session only.
- New shared logic goes in `app/lib/` (e.g. balances read, bulk product ops), not inline in routes.
- Shop-wide balances read: one SQL aggregate (RPC or view) over the inventory ledger; mind the PostgREST 1000-row clamp (aggregate server-side, paginate the SKU list).
- Autopilot-presence lookup: join recent `create_po_draft` audit rows to SKUs client-side from a small dedicated endpoint or an extension of the inventory list DTO; read-only.
- Migrations (if any: media position/alt, balances RPC) ship as checked-in SQL applied via supabase MCP, RLS-scoped.

## Error handling
- Optimistic writes (inline qty, rename) roll back on failure with a toast.
- Bulk endpoint returns per-row results; UI reports "N updated, M failed" with failures listed.
- All list fetch failures show the shared error Placeholder with retry, never a false empty state.

## Testing
- Unit tests for new pure logic: bulk status transitions, balances mapping, membership ops, transfer-picker filtering, PDF-button predicate.
- Full pre-commit gate (typecheck, lint, build) per CLAUDE.md.
- Live browser end-to-end verification of every section (same bar as the Orders rework): search, filters, pagination, bulk flow, inline qty edit, drawer, transfer create/receive, collection rename/delete/membership, location add/delete-guard, image reorder, multi-photo create.

## Build order (one commit per step)
1. Spec + worktree setup.
2. Navigation: 6-tab bar.
3. Catalog: thumbnails, clear-search, sort, bulk actions (+ bulk API).
4. Inventory: search/filter/pagination + balances read.
5. Inventory: inline qty edit + drawer + Autopilot presence.
6. Purchase orders: own fetch + honest PDF predicate + cache key.
7. Transfers: create-from-screen + received history + modal polish.
8. Collections: full management + detail view (+ API).
9. Locations: create/delete + honest states (+ API).
10. Product editor: images (reorder/primary/alt) + compare-at + tracked toggle + InventoryPanel fixes.
11. New product flow: multi-photo.
12. Cross-cutting polish sweep + mobile pass + final e2e verification.
