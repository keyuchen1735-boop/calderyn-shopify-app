/**
 * Shared state + helpers for the Supabase builder-pattern mock.
 *
 * Each test file that uses this must call vi.mock("../supabase.server", mockFactory)
 * where mockFactory is imported from here OR inlined (see test files for usage).
 *
 * The vi.mock() call MUST be at the top level of each test file so Vitest can hoist it.
 */
import { vi, beforeEach } from "vitest";

let nextResponse: { data: unknown; error: unknown } = { data: null, error: null };
let responseQueue: Array<{ data: unknown; error: unknown }> = [];

export function setSupabaseResponse(r: { data: unknown; error: unknown }): void {
  nextResponse = r;
  responseQueue = [];
}

export function setSupabaseResponses(queue: Array<{ data: unknown; error: unknown }>): void {
  responseQueue = [...queue];
  nextResponse = queue[0] ?? { data: null, error: null };
}

const recorded: Record<string, unknown[][]> = {};

function record(method: string, args: unknown[]): void {
  if (!recorded[method]) recorded[method] = [];
  recorded[method].push(args);
}

export function getRecorded(method: string): unknown[][] {
  return (recorded[method] ?? []) as unknown[][];
}

export function resetRecorded(): void {
  for (const k of Object.keys(recorded)) delete recorded[k];
  nextResponse = { data: null, error: null };
  responseQueue = [];
}

function takeNext(): { data: unknown; error: unknown } {
  if (responseQueue.length > 0) {
    return responseQueue.shift() as { data: unknown; error: unknown };
  }
  return nextResponse;
}

export function buildChain(): unknown {
  const c: Record<string, unknown> = {};
  const wrap =
    (name: string) =>
    (...args: unknown[]) => {
      record(name, args);
      return c;
    };
  for (const m of [
    "from",
    "insert",
    "update",
    "delete",
    "select",
    "eq",
    "is",
    "lt",
    "gt",
    "not",
    "order",
    "limit",
    "upsert",
  ]) {
    c[m] = wrap(m);
  }
  c.single = vi.fn(() => Promise.resolve(takeNext()));
  c.maybeSingle = vi.fn(() => Promise.resolve(takeNext()));
  // Handles chains ending without `.single()` / `.maybeSingle()` (e.g. update...select then-able)
  c.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(takeNext()).then(onFulfilled);
  return c;
}

beforeEach(resetRecorded);
