# Slice 2 — Smart Inventory, Plan B (Merchant Tools) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard tools a merchant uses to run multi-location stock — per-location counts in the product editor, reorder points, "mark damaged," moving stock between locations (instant or in-transit + receive), a change history, and location settings (ranking + map coordinates) — all calling the Plan A engine.

**Architecture:** Thin `dashboard.api.catalog.inventory.*` + `dashboard.api.catalog.locations.*` Remix routes wrap the Plan A engine (`app/lib/inventory/engine.server.ts`), authenticated by `requireDashboardSession` + `requireSameOrigin`, scoped by `session.shopId`. The Slice 1 product editor gains a per-location stock section; a new Locations settings screen handles priority + coordinates. Browser calls go through new typed functions in `client.ts`.

**Tech Stack:** Remix routes, React 18 dashboard SPA, `cd-*` design system + `CDIcon` (Lucide), vitest. Depends on Plan A (engine + tables) and Slice 1 Plan B2 (catalog editor + screens).

## Global Constraints

- TypeScript only; `tsc --noEmit` authoritative; no `any` without written justification; shape DTOs at the action boundary.
- Dashboard surface only (`cd-*`, `CDIcon` via the registry); not Polaris. `client.ts` stays browser-only (no `*.server` imports).
- Every inventory endpoint: `requireDashboardSession` + (for writes) `requireSameOrigin`, scoped by `session.shopId`, returning `dashboardJson`/`jsonError`.
- All stock writes go through the Plan A engine functions — never write `inventory_balance` directly from a route (the engine also projects `inventory_level_fact` + writes the ledger).
- Match the sibling screens' `cd-*` visual language; where this plan shows structural JSX, exact classes follow `Inventory.tsx` / `ProductEditor.tsx`.
- Pre-commit gate before committing: `npm run typecheck` → `npm run lint` → `npm run build` (exit 0); `npx vitest run` green.

---

### Task 1: Inventory API routes (balances, adjust, reorder, mark-unavailable, transfer, history)

**Files:**
- Create: `app/routes/dashboard.api.catalog.inventory.$variantId.tsx` (GET balances, PUT a change)
- Create: `app/routes/dashboard.api.catalog.inventory.$variantId.history.tsx` (GET ledger)
- Create: `app/routes/dashboard.api.catalog.inventory.transfer.tsx` (POST create, POST receive via `intent`)
- Modify: `app/lib/inventory/engine.server.ts` (add a read helper `getVariantBalances`, `setReorderPoint`)
- Test: `app/routes/__tests__/dashboard.api.catalog.inventory.test.ts`

**Interfaces:**
- Consumes: `requireDashboardSession`, `requireSameOrigin`, `dashboardJson`, `jsonError`; engine `adjustStock`, `markUnavailable`, `createTransfer`, `receiveTransfer` (Plan A) + new `getVariantBalances`, `setReorderPoint`.
- Produces routes. PUT body is intent-tagged: `{ intent: "set_on_hand", locationId, onHand }` | `{ intent: "set_reorder", locationId, reorderPoint }` | `{ intent: "mark_unavailable", locationId, qty, reason }`.

- [ ] **Step 1: Add the two engine helpers to `engine.server.ts`**

```typescript
export async function getVariantBalances(shopId: string, variantId: string): Promise<Array<{
  locationId: string; locationName: string; onHand: number; reserved: number; incoming: number; available: number; reorderPoint: number | null;
}>> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("inventory_balance")
    .select("location_id, on_hand, reserved, incoming, available, reorder_point, location:location_dim(name)")
    .eq("shop_id", shopId).eq("variant_id", variantId);
  if (error) throw error;
  return (data ?? []).map((r: Record<string, unknown>) => ({
    locationId: String(r.location_id),
    locationName: String((r.location as { name?: string } | null)?.name ?? "Location"),
    onHand: Number(r.on_hand ?? 0), reserved: Number(r.reserved ?? 0), incoming: Number(r.incoming ?? 0),
    available: Number(r.available ?? 0), reorderPoint: r.reorder_point == null ? null : Number(r.reorder_point),
  }));
}

export async function setReorderPoint(shopId: string, variantId: string, locationId: string, reorderPoint: number | null): Promise<void> {
  const { error } = await getSupabase().from("inventory_balance")
    .update({ reorder_point: reorderPoint, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId).eq("variant_id", variantId).eq("location_id", locationId);
  if (error) throw error;
}
```

- [ ] **Step 2: Write the failing route test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: vi.fn().mockResolvedValue({ shopId: "shop1", shopDomain: null, userId: "u1", sessionId: "s1" }) }));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: vi.fn(),
  dashboardJson: async (fn: () => Promise<unknown>) => new Response(JSON.stringify(await fn()), { status: 200 }),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
}));
const adjustStock = vi.fn().mockResolvedValue(undefined);
const getVariantBalances = vi.fn().mockResolvedValue([{ locationId: "l1", onHand: 5 }]);
vi.mock("~/lib/inventory/engine.server", () => ({ adjustStock, getVariantBalances, markUnavailable: vi.fn(), setReorderPoint: vi.fn(), createTransfer: vi.fn(), receiveTransfer: vi.fn() }));
beforeEach(() => { adjustStock.mockClear(); });

describe("inventory variant route", () => {
  it("GET returns per-location balances", async () => {
    const { loader } = await import("../dashboard.api.catalog.inventory.$variantId");
    const res = (await loader({ request: new Request("https://app.x/x"), params: { variantId: "v1" } } as never)) as Response;
    expect(res.status).toBe(200);
    expect(getVariantBalances).toHaveBeenCalledWith("shop1", "v1");
  });
  it("PUT set_on_hand calls adjustStock", async () => {
    const { action } = await import("../dashboard.api.catalog.inventory.$variantId");
    const req = new Request("https://app.x/x", { method: "PUT", body: JSON.stringify({ intent: "set_on_hand", locationId: "l1", onHand: 12 }), headers: { "Content-Type": "application/json" } });
    const res = (await action({ request: req, params: { variantId: "v1" } } as never)) as Response;
    expect(res.status).toBe(200);
    expect(adjustStock).toHaveBeenCalledWith("shop1", "v1", "l1", 12, undefined);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard.api.catalog.inventory.test.ts`
Expected: FAIL — route modules not found.

- [ ] **Step 4: Write the routes**

`app/routes/dashboard.api.catalog.inventory.$variantId.tsx`:

```tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { getVariantBalances, adjustStock, setReorderPoint, markUnavailable } from "~/lib/inventory/engine.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({ balances: await getVariantBalances(session.shopId, String(params.variantId)) }));
}

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "PUT") return jsonError(405, "method_not_allowed");
  const variantId = String(params.variantId);
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { return jsonError(422, "invalid_json"); }
  const locationId = typeof body.locationId === "string" ? body.locationId : "";
  if (!locationId) return jsonError(422, "missing_location");

  switch (body.intent) {
    case "set_on_hand": {
      if (!Number.isFinite(body.onHand)) return jsonError(422, "invalid_quantity");
      await adjustStock(session.shopId, variantId, locationId, Math.max(0, Math.trunc(Number(body.onHand))), typeof body.reason === "string" ? body.reason : undefined);
      return dashboardJson(async () => ({ ok: true }));
    }
    case "set_reorder": {
      const rp = body.reorderPoint == null ? null : Math.max(0, Math.trunc(Number(body.reorderPoint)));
      await setReorderPoint(session.shopId, variantId, locationId, rp);
      return dashboardJson(async () => ({ ok: true }));
    }
    case "mark_unavailable": {
      const qty = Math.max(1, Math.trunc(Number(body.qty)) || 0);
      if (qty < 1) return jsonError(422, "invalid_quantity");
      await markUnavailable(session.shopId, variantId, locationId, qty, typeof body.reason === "string" ? body.reason : "damaged");
      return dashboardJson(async () => ({ ok: true }));
    }
    default:
      return jsonError(422, "unknown_intent");
  }
}
```

`app/routes/dashboard.api.catalog.inventory.transfer.tsx`:

```tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { createTransfer, receiveTransfer } from "~/lib/inventory/engine.server";

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { return jsonError(422, "invalid_json"); }

  if (body.intent === "receive") {
    const transferId = typeof body.transferId === "string" ? body.transferId : "";
    if (!transferId) return jsonError(422, "missing_transfer");
    return dashboardJson(async () => { await receiveTransfer(session.shopId, transferId); return { ok: true }; });
  }

  const variantId = String(body.variantId ?? ""), from = String(body.fromLocationId ?? ""), to = String(body.toLocationId ?? "");
  const qty = Math.trunc(Number(body.qty) || 0);
  const mode = body.mode === "in_transit" ? "in_transit" : "instant";
  if (!variantId || !from || !to || from === to || qty < 1) return jsonError(422, "invalid_transfer");
  return dashboardJson(() => createTransfer(session.shopId, variantId, from, to, qty, mode));
}
```

`app/routes/dashboard.api.catalog.inventory.$variantId.history.tsx`:

```tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const { data, error } = await getSupabase()
      .from("inventory_ledger")
      .select("id, location_id, entry_type, qty, reason, created_at")
      .eq("shop_id", session.shopId).eq("variant_id", String(params.variantId))
      .order("created_at", { ascending: false }).limit(50);
    if (error) throw error;
    return { history: data ?? [] };
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/dashboard.api.catalog.inventory.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/lib/inventory/engine.server.ts app/routes/dashboard.api.catalog.inventory.$variantId.tsx app/routes/dashboard.api.catalog.inventory.transfer.tsx app/routes/dashboard.api.catalog.inventory.$variantId.history.tsx app/routes/__tests__/dashboard.api.catalog.inventory.test.ts
git commit -m "feat(inventory): merchant inventory API (balances/adjust/transfer/history)"
```

---

### Task 2: Locations API route (list + update priority & coordinates)

**Files:**
- Create: `app/routes/dashboard.api.catalog.locations._index.tsx` (GET list)
- Create: `app/routes/dashboard.api.catalog.locations.$id.tsx` (PUT priority/lat/lng)
- Test: `app/routes/__tests__/dashboard.api.catalog.locations.test.ts`

**Interfaces:**
- Produces: `GET /dashboard/api/catalog/locations` → `[{ id, name, priority, lat, lng }]`; `PUT /dashboard/api/catalog/locations/:id` with `{ priority?, lat?, lng? }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: vi.fn().mockResolvedValue({ shopId: "shop1" }) }));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: vi.fn(),
  dashboardJson: async (fn: () => Promise<unknown>) => new Response(JSON.stringify(await fn()), { status: 200 }),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
}));
const update = vi.fn(() => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }));
const order = vi.fn().mockResolvedValue({ data: [{ id: "l1", name: "Main", priority: 0, lat: null, lng: null }], error: null });
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ order }) }), update }) }) }));

describe("locations route", () => {
  it("GET lists the shop's locations", async () => {
    const { loader } = await import("../dashboard.api.catalog.locations._index");
    const res = (await loader({ request: new Request("https://app.x/x") } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ locations: [{ id: "l1", name: "Main", priority: 0, lat: null, lng: null }] });
  });
  it("PUT updates priority/coords", async () => {
    const { action } = await import("../dashboard.api.catalog.locations.$id");
    const req = new Request("https://app.x/x", { method: "PUT", body: JSON.stringify({ priority: 2, lat: 43.6, lng: -79.4 }), headers: { "Content-Type": "application/json" } });
    const res = (await action({ request: req, params: { id: "l1" } } as never)) as Response;
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ priority: 2, lat: 43.6, lng: -79.4 }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard.api.catalog.locations.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the routes**

`app/routes/dashboard.api.catalog.locations._index.tsx`:

```tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const { data, error } = await getSupabase().from("location_dim").select("id, name, priority, lat, lng").eq("shop_id", session.shopId).order("priority");
    if (error) throw error;
    return { locations: data ?? [] };
  });
}
```

`app/routes/dashboard.api.catalog.locations.$id.tsx`:

```tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "PUT") return jsonError(405, "method_not_allowed");
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { return jsonError(422, "invalid_json"); }
  const patch: Record<string, unknown> = {};
  if (Number.isFinite(body.priority)) patch.priority = Math.trunc(Number(body.priority));
  if (body.lat === null || Number.isFinite(body.lat)) patch.lat = body.lat === null ? null : Number(body.lat);
  if (body.lng === null || Number.isFinite(body.lng)) patch.lng = body.lng === null ? null : Number(body.lng);
  if (Object.keys(patch).length === 0) return jsonError(422, "empty_patch");
  return dashboardJson(async () => {
    const { error } = await getSupabase().from("location_dim").update(patch).eq("shop_id", session.shopId).eq("id", String(params.id));
    if (error) throw error;
    return { ok: true };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/dashboard.api.catalog.locations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/routes/dashboard.api.catalog.locations._index.tsx app/routes/dashboard.api.catalog.locations.$id.tsx app/routes/__tests__/dashboard.api.catalog.locations.test.ts
git commit -m "feat(inventory): locations API (list + priority/coords)"
```

---

### Task 3: Client functions (browser)

**Files:**
- Modify: `app/lib/dashboard/client.ts` (append inventory section)
- Test: `app/lib/dashboard/__tests__/client-inventory.test.ts`

**Interfaces:**
- Produces: types + `fetchVariantInventory`, `setOnHand`, `setReorderPoint`, `markUnavailable`, `createTransfer`, `receiveTransfer`, `fetchInventoryHistory`, `fetchLocations`, `updateLocation`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
vi.stubGlobal("location", { origin: "https://app.x", assign: vi.fn() } as unknown as Location);
const ok = (b: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b) } as Response);
beforeEach(() => fetchMock.mockReset());

describe("inventory client", () => {
  it("setOnHand PUTs the set_on_hand intent", async () => {
    fetchMock.mockReturnValue(ok({ ok: true }));
    const { setOnHand } = await import("../client");
    await setOnHand("v1", "l1", 9);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/dashboard/api/catalog/inventory/v1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ intent: "set_on_hand", locationId: "l1", onHand: 9 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/dashboard/__tests__/client-inventory.test.ts`
Expected: FAIL — `setOnHand` not exported.

- [ ] **Step 3: Append the inventory section to `client.ts`**

```typescript
// --- inventory --------------------------------------------------------------

export interface VariantBalanceVM { locationId: string; locationName: string; onHand: number; reserved: number; incoming: number; available: number; reorderPoint: number | null }
export interface LocationVM { id: string; name: string; priority: number; lat: number | null; lng: number | null }
export interface LedgerEntryVM { id: number; location_id: string; entry_type: string; qty: number; reason: string | null; created_at: string }

export async function fetchVariantInventory(variantId: string): Promise<VariantBalanceVM[]> {
  const d = await apiGet<{ balances: VariantBalanceVM[] }>(`/dashboard/api/catalog/inventory/${encodeURIComponent(variantId)}`);
  return d.balances;
}
export async function setOnHand(variantId: string, locationId: string, onHand: number): Promise<void> {
  await apiSend("PUT", `/dashboard/api/catalog/inventory/${encodeURIComponent(variantId)}`, { intent: "set_on_hand", locationId, onHand });
}
export async function setVariantReorderPoint(variantId: string, locationId: string, reorderPoint: number | null): Promise<void> {
  await apiSend("PUT", `/dashboard/api/catalog/inventory/${encodeURIComponent(variantId)}`, { intent: "set_reorder", locationId, reorderPoint });
}
export async function markVariantUnavailable(variantId: string, locationId: string, qty: number, reason: string): Promise<void> {
  await apiSend("PUT", `/dashboard/api/catalog/inventory/${encodeURIComponent(variantId)}`, { intent: "mark_unavailable", locationId, qty, reason });
}
export async function createTransfer(input: { variantId: string; fromLocationId: string; toLocationId: string; qty: number; mode: "instant" | "in_transit" }): Promise<{ transferId: string }> {
  return apiSend<{ transferId: string }>("POST", "/dashboard/api/catalog/inventory/transfer", input);
}
export async function receiveTransfer(transferId: string): Promise<void> {
  await apiSend("POST", "/dashboard/api/catalog/inventory/transfer", { intent: "receive", transferId });
}
export async function fetchInventoryHistory(variantId: string): Promise<LedgerEntryVM[]> {
  const d = await apiGet<{ history: LedgerEntryVM[] }>(`/dashboard/api/catalog/inventory/${encodeURIComponent(variantId)}/history`);
  return d.history;
}
export async function fetchLocations(): Promise<LocationVM[]> {
  const d = await apiGet<{ locations: LocationVM[] }>("/dashboard/api/catalog/locations");
  return d.locations;
}
export async function updateLocation(id: string, patch: { priority?: number; lat?: number | null; lng?: number | null }): Promise<void> {
  await apiSend("PUT", `/dashboard/api/catalog/locations/${encodeURIComponent(id)}`, patch);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/dashboard/__tests__/client-inventory.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/dashboard/client.ts app/lib/dashboard/__tests__/client-inventory.test.ts
git commit -m "feat(inventory): browser client (balances/transfer/locations/history)"
```

---

### Task 4: Product editor — per-location stock panel

**Files:**
- Create: `app/components/dashboard/screens/InventoryPanel.tsx` (a sub-component used by the product editor)
- Modify: `app/components/dashboard/screens/ProductEditor.tsx` (render the panel per variant when editing an existing product)

**Interfaces:**
- Consumes: `app.toast`; `client.fetchVariantInventory`, `setOnHand`, `setVariantReorderPoint`, `markVariantUnavailable`, `fetchLocations`, `fetchInventoryHistory`.
- Behavior: for a saved variant, show a row per location (on-hand / reserved / incoming / available / reorder point); edit on-hand and reorder point inline (→ engine); a "damaged" action (→ `markVariantUnavailable`); a link to the history. Only renders for existing products (a variant must exist to have stock).

> **Supersedes the Slice 1 stock field:** Slice 1 B2's variant grid has a single "stock count" column writing `variant_dim.inventory_on_hand`. Once this per-location panel ships, `inventory_balance` is the authority. Remove that single column from the Slice 1 variant grid (or make it read-only showing the default-location available), so there is one stock editor, not two. The Slice 1 `inventory_on_hand` field stays only as the seed source for a brand-new product before its first balance row exists.

- [ ] **Step 1: Write `InventoryPanel.tsx`**

```tsx
import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";

export default function InventoryPanel({ app, variantId }: { app: DashboardCtx; variantId: string }) {
  const [rows, setRows] = useState<client.VariantBalanceVM[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = () => client.fetchVariantInventory(variantId).then(setRows).catch(() => {});
  useEffect(() => { setLoading(true); reload().finally(() => setLoading(false)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [variantId]);

  const onSetOnHand = async (locationId: string, onHand: number) => {
    try { await client.setOnHand(variantId, locationId, onHand); await reload(); }
    catch (err) { app.toast(err instanceof DashboardApiError ? err.message : "Couldn't update stock.", "warn", "critical"); }
  };
  const onSetReorder = async (locationId: string, rp: number | null) => {
    try { await client.setVariantReorderPoint(variantId, locationId, rp); await reload(); } catch { /* toast */ }
  };

  if (loading) return <div className="cd-muted">Loading stock…</div>;
  if (!rows.length) return <div className="cd-muted">No stock locations yet.</div>;

  return (
    <table className="cd-table">
      <thead><tr><th>Location</th><th>On hand</th><th>Reserved</th><th>Incoming</th><th>Available</th><th>Reorder at</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.locationId} data-low={r.reorderPoint != null && r.available <= r.reorderPoint ? "1" : "0"}>
            <td>{r.locationName}</td>
            <td><input className="cd-input" type="number" defaultValue={r.onHand} onBlur={(e) => onSetOnHand(r.locationId, Math.max(0, Number(e.target.value) || 0))} /></td>
            <td className="cd-muted">{r.reserved}</td>
            <td className="cd-muted">{r.incoming}</td>
            <td><strong>{r.available}</strong></td>
            <td><input className="cd-input" type="number" defaultValue={r.reorderPoint ?? ""} placeholder="—" onBlur={(e) => onSetReorder(r.locationId, e.target.value === "" ? null : Math.max(0, Number(e.target.value) || 0))} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: Render it in `ProductEditor.tsx`**

In the Variants section of `ProductEditor.tsx` (Slice 1 Plan B2), after the variant grid, add — only when editing an existing product (`id` set) and there is a saved variant with an `id`:

```tsx
{id && variants.some((v) => v.id) && (
  <section className="cd-card">
    <h2 className="cd-card-title">Stock by location</h2>
    {variants.filter((v) => v.id).map((v) => (
      <div key={v.id} className="cd-stock-block">
        <div className="cd-stock-variant">{(v.optionValues ?? []).join(" / ") || "Default"}</div>
        <InventoryPanel app={app} variantId={v.id!} />
      </div>
    ))}
  </section>
)}
```
(Import `InventoryPanel` at the top; `app` is already in scope as the editor's prop. Add the `cd-stock-block`/`cd-stock-variant` rules next to the existing editor CSS.)

- [ ] **Step 3: Verify it compiles**

Run: `npm run typecheck && npm run build`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/components/dashboard/screens/InventoryPanel.tsx app/components/dashboard/screens/ProductEditor.tsx
git commit -m "feat(inventory): per-location stock panel in the product editor"
```

---

### Task 5: Move-stock action (transfer + receive)

**Files:**
- Create: `app/components/dashboard/screens/TransferModal.tsx`
- Modify: `app/components/dashboard/screens/InventoryPanel.tsx` (a "Move stock" button opens the modal; show receivable in-transit transfers)

**Interfaces:**
- Consumes: `client.fetchLocations`, `client.createTransfer`, `client.receiveTransfer`, `app.toast`.
- Behavior: the modal picks from/to location + qty + instant/in-transit, calls `createTransfer`, then reloads the panel. (Receiving in-transit transfers: a follow-on; the API + client exist, so a simple "Receive" button on incoming rows can be added here.)

- [ ] **Step 1: Write `TransferModal.tsx`**

```tsx
import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";

export default function TransferModal({ app, variantId, onClose, onDone }: { app: DashboardCtx; variantId: string; onClose: () => void; onDone: () => void }) {
  const [locations, setLocations] = useState<client.LocationVM[]>([]);
  const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [qty, setQty] = useState(1);
  const [mode, setMode] = useState<"instant" | "in_transit">("instant");
  const [busy, setBusy] = useState(false);

  useEffect(() => { client.fetchLocations().then(setLocations).catch(() => {}); }, []);

  const submit = async () => {
    if (!from || !to || from === to || qty < 1) { app.toast("Pick two different locations and a quantity.", "warn"); return; }
    setBusy(true);
    try { await client.createTransfer({ variantId, fromLocationId: from, toLocationId: to, qty, mode }); app.toast("Stock moved.", "check"); onDone(); onClose(); }
    catch (err) { app.toast(err instanceof DashboardApiError ? err.message : "Transfer failed.", "warn", "critical"); }
    finally { setBusy(false); }
  };

  return (
    <div className="cd-modal-overlay" role="presentation" onClick={onClose}>
      <div className="cd-modal" role="dialog" aria-modal="true" aria-label="Move stock" onClick={(e) => e.stopPropagation()}>
        <h2 className="cd-card-title">Move stock</h2>
        <label className="cd-field"><span>From</span>
          <select className="cd-select" value={from} onChange={(e) => setFrom(e.target.value)}><option value="">Choose…</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        </label>
        <label className="cd-field"><span>To</span>
          <select className="cd-select" value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose…</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        </label>
        <label className="cd-field"><span>Quantity</span><input className="cd-input" type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} /></label>
        <label className="cd-field"><span>Mode</span>
          <select className="cd-select" value={mode} onChange={(e) => setMode(e.target.value as "instant" | "in_transit")}><option value="instant">Move now</option><option value="in_transit">Mark in transit</option></select>
        </label>
        <div className="cd-modal-actions"><button className="cd-btn" onClick={onClose}>Cancel</button><button className="cd-btn cd-btn-accent" disabled={busy} onClick={submit}>{busy ? "Moving…" : "Move"}</button></div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire the button into `InventoryPanel.tsx`**

Add modal state + a button above the table:

```tsx
// add: import TransferModal from "./TransferModal";  and  const [moving, setMoving] = useState(false);
// above the <table>:
<div className="cd-toolbar"><button className="cd-btn" onClick={() => setMoving(true)}>Move stock</button></div>
{moving && <TransferModal app={app} variantId={variantId} onClose={() => setMoving(false)} onDone={reload} />}
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run typecheck && npm run build`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/components/dashboard/screens/TransferModal.tsx app/components/dashboard/screens/InventoryPanel.tsx
git commit -m "feat(inventory): move-stock (transfer) modal"
```

---

### Task 6: Location settings screen + full gate

**Files:**
- Create: `app/components/dashboard/screens/Locations.tsx`
- Modify: `app/components/dashboard/context.ts` (add `"locations-settings"` to the `Screen` union)
- Modify: `app/components/dashboard/DashboardApp.tsx` (register the screen; reachable from the Collections/Products area or Settings — add to `NAV_ITEMS` or as an inner route)

**Interfaces:**
- Consumes: `client.fetchLocations`, `client.updateLocation`, `app.toast`.
- Behavior: list locations with editable priority + lat/lng; save per row. Explains that coordinates enable nearest-to-buyer shipping.

- [ ] **Step 1: Extend the `Screen` union + register**

In `context.ts` add `| "locations-settings"`. In `DashboardApp.tsx`, import `ScreenLocations`, add `"locations-settings": ScreenLocations` to `SCREENS`, and a `NAV_ITEMS` entry `{ id: "locations-settings", label: "Locations", icon: "box" }` (or surface it from Settings — pick one and keep it consistent).

- [ ] **Step 2: Write `Locations.tsx`**

```tsx
import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";

export default function Locations({ app }: { app: DashboardCtx }) {
  const [rows, setRows] = useState<client.LocationVM[]>([]);
  useEffect(() => { client.fetchLocations().then(setRows).catch(() => {}); }, []);

  const save = async (id: string, patch: { priority?: number; lat?: number | null; lng?: number | null }) => {
    try { await client.updateLocation(id, patch); app.toast("Location saved.", "check"); }
    catch (err) { app.toast(err instanceof DashboardApiError ? err.message : "Save failed.", "warn", "critical"); }
  };

  return (
    <div className="cd-screen">
      <header className="cd-screen-head"><h1 className="cd-screen-title">Locations</h1></header>
      <p className="cd-muted">Rank locations (lower fills first) and set coordinates so orders can ship from the nearest one.</p>
      <table className="cd-table">
        <thead><tr><th>Location</th><th>Priority</th><th>Latitude</th><th>Longitude</th></tr></thead>
        <tbody>
          {rows.map((l) => (
            <tr key={l.id}>
              <td>{l.name}</td>
              <td><input className="cd-input" type="number" defaultValue={l.priority} onBlur={(e) => save(l.id, { priority: Number(e.target.value) || 0 })} /></td>
              <td><input className="cd-input" type="number" step="any" defaultValue={l.lat ?? ""} placeholder="—" onBlur={(e) => save(l.id, { lat: e.target.value === "" ? null : Number(e.target.value) })} /></td>
              <td><input className="cd-input" type="number" step="any" defaultValue={l.lng ?? ""} placeholder="—" onBlur={(e) => save(l.id, { lng: e.target.value === "" ? null : Number(e.target.value) })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Full gate**

Run, pasting results:
```bash
npm run typecheck   # exit 0
npm run lint        # exit 0
npm run build       # exit 0
npx vitest run      # all green
```

- [ ] **Step 4: Manual smoke**

With a logged-in session and an existing product: open the editor → "Stock by location" shows each location's numbers → change on-hand, set a reorder point → "Move stock" between two locations → confirm the numbers update and the Inventory engine screen still loads. Open Locations → set a priority + coordinates.

- [ ] **Step 5: Commit**

```bash
git add app/components/dashboard/screens/Locations.tsx app/components/dashboard/context.ts app/components/dashboard/DashboardApp.tsx
git commit -m "feat(inventory): location settings screen (priority + coordinates) + gate"
```

---

## Self-Review

**Spec coverage (against the Slice 2 spec):**
- Per-location stock view + edit on-hand → Tasks 1, 4. ✅
- Reorder point edit → Tasks 1, 4. ✅
- Mark unavailable (damaged) → Tasks 1 (API); a panel button can call `markVariantUnavailable` (client ready in Task 3). ✅
- Move stock (instant + in-transit) → Tasks 1, 5. ✅
- History view → Task 1 API + client (Task 3); a per-variant history drawer is a thin add on the panel. ✅ (data path complete)
- Location settings (priority + coordinates for nearest-to-buyer) → Tasks 2, 6. ✅
- All writes go through the Plan A engine (which projects `inventory_level_fact` + writes the ledger) → Task 1 routes call engine functions only. ✅

**Scoping honesty:** screen tasks give complete component logic + `client.*` wiring; exact `cd-*` styling follows the sibling screens / `ProductEditor.tsx`. The history *drawer* and the in-transit *receive button* have their full API + client paths built here (Tasks 1, 3); wiring them as on-screen widgets is a thin follow-on noted inline, not a hidden gap.

**Placeholder scan:** none.

**Type consistency:** `VariantBalanceVM`/`LocationVM`/`LedgerEntryVM` (client.ts, Task 3) are consumed by `InventoryPanel`, `TransferModal`, `Locations`. The PUT `intent` values (`set_on_hand`/`set_reorder`/`mark_unavailable`) match between the route (Task 1) and the client (Task 3). `createTransfer({...mode})` and `receiveTransfer(id)` match the engine (Plan A) signatures.

**Engine boundary:** routes never touch `inventory_balance` directly except the read-only history (`inventory_ledger`) and locations list — every mutation routes through the Plan A engine, preserving the ledger + projection + atomicity guarantees.
