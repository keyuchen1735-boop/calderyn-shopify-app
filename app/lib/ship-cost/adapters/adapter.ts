// Shared, provider-blind ship-cost connector contract. Each carrier/3PL provider
// (easypost, later shippo, shipbob, …) implements only `connect()` + a per-shop
// `ShipSource` that returns NORMALIZED per-shipment charges. The generic landing
// core (ship-cost/adapters/land.server.ts), the resolver, and everything above it
// never branch on provider — exactly like the ad-ingestion core (ads/adapter.ts).

export type ShipProvider = "easypost" | "shippo" | "shipbob" | "shiphero";

export type ShipIntegrationKind =
  | "easypost_ship"
  | "shippo_ship"
  | "shipbob_ship"
  | "shiphero_ship"; // one enum value per provider (C7/C9)

/** One purchased label / shipment charge, normalized across providers. */
export interface NormalizedShipmentCost {
  /** Provider's stable charge/shipment/transaction id — the idempotency key. */
  externalId: string;
  /** Provider reference / order name, if present (else null → match falls to tracking). */
  orderRef: string | null;
  /** Tracking number, if present (else null). Primary match key when orderRef is absent. */
  trackingNo: string | null;
  /** ACTUAL paid amount, integer cents (provider decimal strings parsed without float drift). */
  costCents: number;
  /** ISO-4217, e.g. "USD". */
  currency: string;
  /** ISO-8601 ship/created timestamp, if present. */
  shippedAt: string | null;
  /** Underlying carrier (e.g. "USPS"), informational — distinct from the provider. */
  carrier: string | null;
}

/** Per-shop, already-authenticated handle over one provider's charge data. */
export interface ShipSource {
  /**
   * Fetch normalized charges. `since` is an ISO lower bound (a trailing re-pull
   * window); null means no bound. Implementations page until they pass `since`.
   */
  fetchCharges(since: string | null): Promise<NormalizedShipmentCost[]>;
}

/** A provider plug. `connect` returns null when the shop has NO credential stored. */
export interface ShipCostAdapter {
  readonly provider: ShipProvider;
  readonly integrationKind: ShipIntegrationKind;
  // null = no credential stored (shop not connected) → cron marks "skipped".
  // THROW = a credential is stored but the connection is broken (e.g. ShipHero refresh
  // failed) → cron records sync_status:'error' (failure-visibility, rule 12).
  connect(shopId: string): Promise<ShipSource | null>;
}
