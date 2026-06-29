// app/lib/shipping/engine.server.ts
// The single swap point between the passthrough stub and #6.3's real quote engine.
// Server-only (.server.ts) so the engine never reaches the client bundle.
// getShippingEngine() is invoked from the CarrierService callback (#6.4), storefront,
// and MCP — no surface re-implements quoting (single source of truth).
import type { QuoteShipping } from "./quote";
import { realQuoteShipping } from "./engine.impl.server";

export function getShippingEngine(): QuoteShipping {
  // #6.3 real engine: parcel packing, markup/handling/free-ship rules, delivery
  // windows, request-hash caching, and fallback surfacing. The passthrough stub
  // (engine.stub.server.ts) remains for #6.4's contract-only tests.
  return realQuoteShipping;
}
