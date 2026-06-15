/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory supabase fake */

/**
 * Shared in-memory Supabase stub for ship-cost unit tests.
 *
 * Tracks inserts and updates per table so tests can assert:
 *   sb.inserts("shipping_cost_period")[0]
 *   sb.updates("order_fact")
 *
 * Supports the subset of the Supabase query builder used by the ship-cost
 * module: .from(), .select(), .eq(), .not(), .insert(), .update(), .upsert(),
 * .single(), .maybeSingle().
 */

interface InsertRecord {
  table: string;
  payload: Record<string, unknown> | Record<string, unknown>[];
}

interface UpdateRecord {
  table: string;
  payload: Record<string, unknown>;
  filters: Record<string, unknown>;
}

interface UpsertRecord {
  table: string;
  payload: Record<string, unknown>;
}

export function makeFakeSupabase(tables: Record<string, any[]>) {
  const inserts: InsertRecord[] = [];
  const updates: UpdateRecord[] = [];
  const upserts: UpsertRecord[] = [];

  function makeChain(table: string, rows: any[]) {
    let selectedRows = [...rows];
    let insertedId = 1;

    const chain: any = {
      select(_cols?: string) {
        return chain;
      },
      eq(col: string, val: unknown) {
        selectedRows = selectedRows.filter((r) => r[col] === val);
        return chain;
      },
      not(col: string, _op: string, _val: unknown) {
        selectedRows = selectedRows.filter((r) => r[col] !== null && r[col] !== undefined);
        return chain;
      },
      in(col: string, vals: unknown[]) {
        selectedRows = selectedRows.filter((r) => vals.includes(r[col]));
        return chain;
      },
      insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
        inserts.push({ table, payload });
        // Return a chain that supports .select("id").single() for period insert
        const insertedRow = Array.isArray(payload) ? payload[0] : payload;
        const withId = { id: `fake-id-${insertedId++}`, ...insertedRow };
        const insertChain: any = {
          select(_cols?: string) {
            return insertChain;
          },
          single() {
            return Promise.resolve({ data: withId, error: null });
          },
          then(cb: (r: { data: null; error: null }) => unknown) {
            return Promise.resolve(cb({ data: null, error: null }));
          },
        };
        return insertChain;
      },
      update(payload: Record<string, unknown>) {
        const updateFilters: Record<string, unknown> = {};
        const updateChain: any = {
          eq(col: string, val: unknown) {
            updateFilters[col] = val;
            selectedRows = selectedRows.filter((r) => r[col] === val);
            return updateChain;
          },
          then(cb: (r: { data: null; error: null }) => unknown) {
            updates.push({ table, payload: { ...payload, ...updateFilters }, filters: updateFilters });
            return Promise.resolve(cb({ data: null, error: null }));
          },
        };
        return updateChain;
      },
      upsert(payload: Record<string, unknown>) {
        upserts.push({ table, payload });
        return Promise.resolve({ data: null, error: null });
      },
      single() {
        return Promise.resolve({ data: selectedRows[0] ?? null, error: null });
      },
      maybeSingle() {
        return Promise.resolve({ data: selectedRows[0] ?? null, error: null });
      },
      then(cb: (r: { data: any[]; error: null }) => unknown) {
        return Promise.resolve(cb({ data: selectedRows, error: null }));
      },
    };
    return chain;
  }

  const sb: any = {
    from(table: string) {
      const rows = tables[table] ?? [];
      return makeChain(table, rows);
    },
    inserts(table: string): Record<string, unknown>[] {
      const out: Record<string, unknown>[] = [];
      for (const rec of inserts) {
        if (rec.table !== table) continue;
        if (Array.isArray(rec.payload)) {
          out.push(...rec.payload);
        } else {
          out.push(rec.payload);
        }
      }
      return out;
    },
    updates(table: string): Record<string, unknown>[] {
      return updates.filter((u) => u.table === table).map((u) => u.payload);
    },
    upserts(table: string): Record<string, unknown>[] {
      return upserts.filter((u) => u.table === table).map((u) => u.payload);
    },
  };

  return sb;
}
