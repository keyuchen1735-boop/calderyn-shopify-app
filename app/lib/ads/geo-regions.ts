// Map Calderyn's coarse internal region buckets to real ad-platform geo targets.
// Single source of truth: REGION_STATES (region -> US states). Each platform then
// translates those states into its own geo-entity IDs.
//
// Google geo target constant IDs come from Google's published geotargets CSV
// (Target Type = State, Country = US): https://developers.google.com/google-ads/api/data/geotargets
// They are stable public data. The coverage test guarantees every state has an
// entry; a transcription error would surface as a Google API error at runtime
// (never a silent no-op). Verify against the current CSV before relying on live
// Google calls.

import type { RegionCode } from "./actions";
import { VALID_REGIONS } from "./actions";

export type UsState =
  | "AL" | "AK" | "AZ" | "AR" | "CA" | "CO" | "CT" | "DE" | "DC" | "FL"
  | "GA" | "HI" | "ID" | "IL" | "IN" | "IA" | "KS" | "KY" | "LA" | "ME"
  | "MD" | "MA" | "MI" | "MN" | "MS" | "MO" | "MT" | "NE" | "NV" | "NH"
  | "NJ" | "NM" | "NY" | "NC" | "ND" | "OH" | "OK" | "OR" | "PA" | "RI"
  | "SC" | "SD" | "TN" | "TX" | "UT" | "VT" | "VA" | "WA" | "WV" | "WI" | "WY";

// Internal region buckets -> US states. Disjoint, covering all 50 states + DC.
export const REGION_STATES: Record<RegionCode, readonly UsState[]> = {
  "us-west": ["WA", "OR", "CA", "NV", "ID", "MT", "WY", "UT", "CO", "AZ", "NM", "AK", "HI"],
  "us-central": ["ND", "SD", "NE", "KS", "MN", "IA", "MO", "WI", "IL", "IN", "MI", "OH", "OK", "TX"],
  "us-south": ["AR", "LA", "MS", "AL", "TN", "KY", "GA", "FL", "SC", "NC", "VA", "WV"],
  "us-east": ["ME", "NH", "VT", "MA", "RI", "CT", "NY", "NJ", "PA", "DE", "MD", "DC"],
};

// Official Google Ads geo target constant numeric IDs per US state.
const GOOGLE_STATE_ID: Record<UsState, string> = {
  AL: "21133", AK: "21132", AZ: "21135", AR: "21136", CA: "21137", CO: "21138",
  CT: "21139", DE: "21140", DC: "21141", FL: "21142", GA: "21143", HI: "21144",
  ID: "21145", IL: "21146", IN: "21147", IA: "21148", KS: "21149", KY: "21150",
  LA: "21151", ME: "21152", MD: "21153", MA: "21154", MI: "21155", MN: "21156",
  MS: "21157", MO: "21158", MT: "21159", NE: "21160", NV: "21161", NH: "21162",
  NJ: "21163", NM: "21164", NY: "21167", NC: "21165", ND: "21166", OH: "21168",
  OK: "21169", OR: "21170", PA: "21171", RI: "21172", SC: "21173", SD: "21174",
  TN: "21175", TX: "21176", UT: "21177", VT: "21178", VA: "21179", WA: "21180",
  WV: "21182", WI: "21183", WY: "21184",
};

/** Google `geoTargetConstants/<id>` resource names for every state in a region. */
export function googleGeoTargetConstants(region: RegionCode): string[] {
  return REGION_STATES[region].map((s) => `geoTargetConstants/${GOOGLE_STATE_ID[s]}`);
}

// Full state names. Meta has no published US-state geo CSV like Google's; its
// region "key" is a numeric id resolved at runtime from the adgeolocation
// targeting-search API, queried by the state's full name (see
// app/lib/meta/actions.server.ts). The name is the stable, verifiable input —
// the coverage test asserts every state has a unique non-empty name so the live
// resolver is never handed an empty or ambiguous query. "District of Columbia"
// (DC) matches Meta's own region name for the federal district.
export const US_STATE_NAMES: Record<UsState, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

/** Full state names for every state in a region — the query inputs Meta's
 * adgeolocation search resolves to numeric region keys. */
export function regionStateNames(region: RegionCode): string[] {
  return REGION_STATES[region].map((s) => US_STATE_NAMES[s]);
}

// Reverse index: Google geo-target numeric id -> our RegionCode. Built from the
// same REGION_STATES + GOOGLE_STATE_ID maps used to target campaigns, so it can
// never drift from the forward mapping.
const GOOGLE_ID_TO_REGION: Record<string, RegionCode> = (() => {
  const idx: Record<string, RegionCode> = {};
  (Object.keys(REGION_STATES) as RegionCode[]).forEach((region) => {
    for (const st of REGION_STATES[region]) idx[GOOGLE_STATE_ID[st]] = region;
  });
  return idx;
})();

const REGION_SET = new Set<string>(VALID_REGIONS);

/**
 * Resolve a campaign's `geo_targets` to exactly ONE RegionCode, or null if it
 * targets zero/multiple/unrecognized regions (→ ineligible for weather moves).
 * Accepts RegionCode literals ("us-west", seed shops) and Google
 * geoTargetConstants ("geoTargetConstants/21167") or bare numeric ids. Any
 * unrecognized entry makes the whole campaign ineligible.
 */
export function regionForGeoTargets(geoTargets: string[]): RegionCode | null {
  if (geoTargets.length === 0) return null;
  const regions = new Set<RegionCode>();
  for (const t of geoTargets) {
    if (REGION_SET.has(t)) {
      regions.add(t as RegionCode);
      continue;
    }
    const id = t.match(/geoTargetConstants\/(\d+)/)?.[1] ?? t.match(/^(\d+)$/)?.[1];
    const region = id ? GOOGLE_ID_TO_REGION[id] : undefined;
    if (!region) return null;
    regions.add(region);
  }
  return regions.size === 1 ? [...regions][0] : null;
}
