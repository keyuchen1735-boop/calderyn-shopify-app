// DTO shapes shared by the customer-directory read model (directory.server.ts)
// and the dashboard client/screen. Plain types only — safe to import from the
// browser.

import type { WeatherSuggestionDTO } from "../weather/types";

/** One bucket per buyer, priority VIP > At risk > Repeat > New > One-time;
 *  buyers with zero purchases are "Prospect". */
export type CustomerSegment =
  | "VIP"
  | "Repeat"
  | "New"
  | "At risk"
  | "One-time"
  | "Prospect";

export interface CustomerStats {
  customers: number;
  /** Repeat buyers ÷ buyers with ≥1 purchase; null when nobody has purchased. */
  repeatRatePct: number | null;
  /** Buyers whose latest marketing consent is accepted ÷ all buyers; null when
   *  there are no buyers. */
  marketingConsentPct: number | null;
  /** Total purchase value ÷ buyers with ≥1 purchase; null when nobody has purchased. */
  blendedLtvCents: number | null;
}

export interface CustomerRow {
  id: string;
  email: string;
  city: string | null;
  country: string | null;
  segment: CustomerSegment;
  orders: number;
  spentCents: number;
  lastOrderAt: string | null;
  createdAt: string;
}

export interface SegmentDef {
  key: string;
  name: string;
  /** Plain-language rule text, e.g. "Placed more than one order". */
  basis: string;
  count: number;
  /** Share of all buyers, pre-rendered like "31%". */
  pct: string;
}

export interface CustomersPage {
  stats: CustomerStats;
  customers: CustomerRow[];
  segments: SegmentDef[];
  /** Pending weather-reallocation suggestions for the Segments → Weather panel. Empty for opted-out shops. */
  weatherSuggestions: WeatherSuggestionDTO[];
}

export interface CustomerAddress {
  kind: string;
  name: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postal: string | null;
  country: string | null;
  isDefault: boolean;
}

export interface CustomerConsent {
  policy: string;
  accepted: boolean;
  capturedAt: string;
}

export interface CustomerOrderRow {
  id: string;
  ref: string;
  createdAt: string;
  /** Line summary from title snapshots, e.g. "2× Rain Shell 2.0". */
  items: string;
  totalCents: number;
  state: string;
}

export interface CustomerCartLine {
  title: string;
  quantity: number;
  priceCents: number;
}

export interface CustomerCart {
  items: CustomerCartLine[];
  valueCents: number;
}

export interface CustomerProfile {
  id: string;
  email: string;
  phone: string | null;
  city: string | null;
  country: string | null;
  segment: CustomerSegment;
  since: string;
  ordersCount: number;
  spentCents: number;
  aovCents: number;
  lastOrderAt: string | null;
}

export interface CustomerDetail {
  customer: CustomerProfile;
  addresses: CustomerAddress[];
  /** Latest row per policy. */
  consents: CustomerConsent[];
  /** Up to 10 latest orders. */
  orders: CustomerOrderRow[];
  /** Newest open cart with lines, else null. */
  cart: CustomerCart | null;
}
