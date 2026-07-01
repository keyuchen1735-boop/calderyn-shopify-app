/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fake supabase for owned-ingest tests */
// Minimal in-memory Supabase stand-in, modeled on the Shopify transform test harness
// (app/lib/ingest/__tests__/transform.test.ts). Records writes for assertions and can
// simulate a transient read failure per table.
export type Row = Record<string, any>;

export interface FakeCalls {
  upserts: Array<{ table: string; rows: any; opts?: any }>;
  inserts: Array<{ table: string; rows: any }>;
  updates: Array<{ table: string; set: any }>;
  deletes: Array<{ table: string }>;
}

export function makeFakeSupabase(opts?: {
  seed?: Record<string, Row[]>;
  // Table -> the id returned by upsert(...).select().single() (order_fact needs one).
  upsertReturns?: Record<string, Row>;
  failRead?: string[];
}) {
  const store: Record<string, Row[]> = { ...(opts?.seed ?? {}) };
  const failReadTables = new Set(opts?.failRead ?? []);
  const upsertReturns = opts?.upsertReturns ?? {};
  const calls: FakeCalls = { upserts: [], inserts: [], updates: [], deletes: [] };

  function builder(table: string): any {
    const filters: Array<[string, any]> = [];
    const matches = () => (store[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
    const readErr = () => (failReadTables.has(table) ? new Error(`read failed: ${table}`) : null);
    const api: any = {
      select: () => api,
      order: () => api,
      limit: () => api,
      is: () => api,
      eq: (k: string, v: any) => { filters.push([k, v]); return api; },
      maybeSingle: async () => ({ data: matches()[0] ?? null, error: readErr() }),
      single: async () => ({ data: upsertReturns[table] ?? matches()[0] ?? null, error: readErr() }),
      upsert: (rows: any, o?: any) => {
        calls.upserts.push({ table, rows, opts: o });
        const chain: any = {
          select: () => chain,
          single: async () => ({ data: upsertReturns[table] ?? { id: "order-uuid" }, error: null }),
          then: (res: (r: { data: any; error: null }) => unknown) => res({ data: [], error: null }),
        };
        return chain;
      },
      insert: (rows: any) => { calls.inserts.push({ table, rows }); return api; },
      update: (set: any) => { calls.updates.push({ table, set }); return api; },
      delete: () => { calls.deletes.push({ table }); return api; },
      then: (res: (r: { data: any; error: any }) => unknown) => res({ data: matches(), error: readErr() }),
    };
    return api;
  }

  return { client: { from: (t: string) => builder(t) } as any, calls, store };
}
