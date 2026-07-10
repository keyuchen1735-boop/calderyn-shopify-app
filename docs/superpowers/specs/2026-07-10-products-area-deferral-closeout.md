# Products-area deferral closeout (2026-07-10)

This is the durable disposition of every small follow-up deferred by PR #418. “Closed” means the
generic or speculative work is intentionally not part of the Products completion scope; it can be
reopened only with new evidence or a tighter product contract.

| Deferral | Disposition | Rationale / owner |
| --- | --- | --- |
| Real purchase orders (suppliers, ETA, receive) | Shipped in the purchase-order branch | The real PO entity, supplier management, lifecycle, receiving, incoming/on-hand projection, and reliability follow-up are implemented end to end. |
| Product SEO fields | Separate branch | Handle, meta title, and meta description are owned by the SEO-fields workstream so schema, API, editor, and storefront metadata ship as one slice. |
| Bulk “Fix with AI” | Closed pending a deterministic contract | Do not ship an opaque bulk mutation. Reopen only when each operation has deterministic inputs/outputs, an explicit cost model, and a durable preview/undo contract. |
| Shared paged-list abstraction | Closed | Products-area lists have materially different cache identity, stale-data, loading, selection, and mutation semantics; sharing mechanics now would obscure those contracts. |
| Generic bulk-action module | Closed | Orders and Catalog require different idempotency, partial-failure, retry, authorization, and error-reporting semantics. Keep their bulk workflows domain-owned. |
| Global Modal extraction | Broad migration closed | The PO work ships the shared `useModalChrome` accessibility/focus/escape kernel. Migrating every existing modal globally has no user-facing payoff and remains out of scope. |
| Keyset pagination for `inventory_list` | Closed until measured need | Offset pagination remains adequate. Reopen with production evidence of a tenant above 10,000 inventory rows or measured query/UX degradation. |
| Hide archived inventory | Closed as intentional parity | Archived inventory remains visible by design, matching Shopify’s inventory-management behavior and preserving operational/history visibility. |
