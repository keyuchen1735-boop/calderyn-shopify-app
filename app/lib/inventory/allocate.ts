// Pure allocator: decides the order in which locations are tried to cover a
// reservation. Nearest-to-buyer (haversine) when a destination and the
// location's coordinates are both present; otherwise fall back to the
// merchant's priority ranking (lower = filled first). No DB, no side effects.
export type Loc = { id: string; priority: number; lat: number | null; lng: number | null };
export type Dest = { lat: number; lng: number } | null;

function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function orderLocations(locations: Loc[], dest: Dest): string[] {
  const distance = (l: Loc): number | null =>
    dest && l.lat != null && l.lng != null ? haversine(dest.lat, dest.lng, l.lat, l.lng) : null;
  return [...locations]
    .sort((a, b) => {
      const da = distance(a), db = distance(b);
      if (da != null && db != null && da !== db) return da - db; // both located -> nearer first
      if (da != null && db == null) return -1;                   // located before un-located
      if (da == null && db != null) return 1;
      return a.priority - b.priority;                            // fall back to priority
    })
    .map((l) => l.id);
}
