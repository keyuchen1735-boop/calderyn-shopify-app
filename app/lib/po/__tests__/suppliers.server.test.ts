// Unit tests for the supplier lib: boundary validation and the named 422/404
// mappings (duplicate name, missing row). Supabase is a minimal queued mock.
import { describe, it, expect, vi, beforeEach } from "vitest";

interface Res {
  data: unknown;
  error: unknown;
}

const state = vi.hoisted(() => ({
  queue: [] as Res[],
  payloads: [] as unknown[],
}));

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => {
    const b: Record<string, unknown> = {};
    const chain = (name: string) => {
      b[name] = () => b;
    };
    for (const m of ["select", "eq", "order"]) chain(m);
    b.insert = (payload: unknown) => {
      state.payloads.push(payload);
      return b;
    };
    b.update = (payload: unknown) => {
      state.payloads.push(payload);
      return b;
    };
    const resolve = () => state.queue.shift() ?? { data: null, error: null };
    b.single = () => Promise.resolve(resolve());
    b.maybeSingle = () => Promise.resolve(resolve());
    b.then = (onOk: (v: Res) => unknown, onErr?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onOk, onErr);
    return { from: () => b } as never;
  },
}));

import {
  createSupplier,
  listSuppliers,
  setSupplierActive,
  updateSupplier,
  validateSupplierInput,
} from "../suppliers.server";

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

const ROW = {
  id: "sup-1",
  name: "Acme Textiles",
  email: "orders@acme.example",
  phone: null,
  notes: null,
  lead_time_days: 7,
  active: true,
  created_at: "2026-07-01T00:00:00Z",
};

beforeEach(() => {
  state.queue.length = 0;
  state.payloads.length = 0;
});

describe("validateSupplierInput", () => {
  it("trims and normalizes empties to null", () => {
    expect(
      validateSupplierInput({ name: "  Acme  ", email: "", phone: null, leadTimeDays: "14" }),
    ).toEqual({ name: "Acme", email: null, phone: null, notes: null, leadTimeDays: 14 });
  });

  it.each([
    ["empty name", { name: "  " }],
    ["missing name", {}],
    ["overlong name", { name: "x".repeat(121) }],
    ["negative lead time", { name: "Acme", leadTimeDays: -1 }],
    ["lead time over a year", { name: "Acme", leadTimeDays: 366 }],
    ["fractional lead time", { name: "Acme", leadTimeDays: 2.5 }],
    ["non-string email", { name: "Acme", email: 7 }],
  ])("rejects %s as invalid_supplier", (_name, body) => {
    expect(capture(() => validateSupplierInput(body as Record<string, unknown>))).toMatchObject({
      code: "invalid_supplier",
      status: 422,
    });
  });
});

describe("suppliers CRUD wrappers", () => {
  it("lists and maps rows", async () => {
    state.queue.push({ data: [ROW], error: null });
    expect(await listSuppliers("shop-1")).toEqual([
      {
        id: "sup-1",
        name: "Acme Textiles",
        email: "orders@acme.example",
        phone: null,
        notes: null,
        leadTimeDays: 7,
        active: true,
        createdAt: "2026-07-01T00:00:00Z",
      },
    ]);
  });

  it("maps a duplicate-name unique violation to supplier_name_taken", async () => {
    state.queue.push({ data: null, error: { code: "23505", message: "duplicate key" } });
    await expect(
      createSupplier("shop-1", { name: "Acme" }),
    ).rejects.toMatchObject({ code: "supplier_name_taken", status: 422 });
  });

  it("404s supplier_not_found when updating a missing supplier", async () => {
    state.queue.push({ data: null, error: null });
    await expect(
      updateSupplier("shop-1", "sup-x", { name: "Acme" }),
    ).rejects.toMatchObject({ code: "supplier_not_found", status: 404 });
  });

  it("setSupplierActive flips the flag and returns the mapped row", async () => {
    state.queue.push({ data: { ...ROW, active: false }, error: null });
    const updated = await setSupplierActive("shop-1", "sup-1", false);
    expect(updated.active).toBe(false);
    expect(state.payloads[0]).toMatchObject({ active: false });
  });
});
