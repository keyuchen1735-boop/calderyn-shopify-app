import { describe, expect, it } from "vitest";

import { IMPORTED_SALE_STATE_FILTER } from "../commerce.server";

describe("IMPORTED_SALE_STATE_FILTER", () => {
  // Regression guard for a silent revenue-zeroing bug: imported_order.financial_status is
  // stored verbatim (ingest/mappers.server.ts writes Shopify's displayFinancialStatus as-is),
  // so the Admin GraphQL backfill — the primary migration funnel — supplies the UPPERCASE enum
  // while REST/webhook rows are lowercase. PostgREST .in() is case-sensitive, so a lowercase-only
  // filter drops every GraphQL-migrated order out of gross / order count / the Shopify channel
  // total, collapsing a just-migrated store's revenue to zero.
  it("matches both the lowercase and UPPERCASE spelling of every captured state", () => {
    for (const state of ["paid", "partially_paid", "partially_refunded", "refunded"]) {
      expect(IMPORTED_SALE_STATE_FILTER).toContain(state);
      expect(IMPORTED_SALE_STATE_FILTER).toContain(state.toUpperCase());
    }
  });

  it("still excludes states where money was never captured", () => {
    // pending / authorized / voided / expired must never count as a sale, in either case.
    for (const state of ["pending", "authorized", "voided", "expired"]) {
      expect(IMPORTED_SALE_STATE_FILTER).not.toContain(state);
      expect(IMPORTED_SALE_STATE_FILTER).not.toContain(state.toUpperCase());
    }
  });
});
