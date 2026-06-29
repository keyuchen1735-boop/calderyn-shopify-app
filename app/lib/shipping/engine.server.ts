// app/lib/shipping/engine.server.ts
// The single swap point between the passthrough stub and #6.3's real quote engine.
// Server-only (.server.ts) so the engine never reaches the client bundle.
// getShippingEngine() is invoked from the CarrierService callback (#6.4), storefront,
// and MCP — no surface re-implements quoting (single source of truth).
import type { QuoteShipping } from "./quote";
import { stubQuoteShipping } from "./engine.stub.server";

export function getShippingEngine(): QuoteShipping {
  // ponytail: passthrough stub by default so consumers build against the frozen
  // contract. The ENTIRE swap to the real #6.3 engine is one line:
  //   return realQuoteShipping; // once ./engine.impl.server.ts exists
  return stubQuoteShipping;
}
