import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Card, SectionTitle } from "../ui";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import { cacheScreenData, cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";

// Location settings: rank locations (priority — lower fills first), set map
// coordinates so the allocator can fill orders from the nearest location to
// the buyer, and configure the ship-from address used on outbound labels.
// URL-only page (/dashboard/products/locations): no Products subtab entry,
// so no subtab bar renders here.

const GRID = "2fr 1fr 1fr 1fr";

export default function Locations({ app }: { app: DashboardCtx }) {
  // Seeded from the session cache so a return visit paints instantly; the
  // mount fetch below revalidates and writes back through.
  const [rows, setRows] = useState<client.LocationVM[]>(
    () => cachedScreenData<client.LocationVM[]>(SCREEN_CACHE_KEYS.locations) ?? [],
  );

  useEffect(() => {
    client
      .fetchLocations()
      .then((r) => setRows(cacheScreenData(SCREEN_CACHE_KEYS.locations, r)))
      .catch(() => {});
  }, []);

  const save = async (
    id: string,
    patch: Parameters<typeof client.updateLocation>[1],
  ) => {
    try {
      await client.updateLocation(id, patch);
      app.toast("Location saved.", "check");
    } catch (err) {
      app.toast(
        err instanceof DashboardApiError ? err.message : "Couldn't save the location.",
        "warn",
        "critical",
      );
    }
  };

  return (
    <div className="cd-screen">
      <header className="cd-screen-head" data-screen-label="Locations">
        <h1 className="cd-h1">Locations</h1>
      </header>
      <Card pad={false}>
        <p className="cd-caption" style={{ padding: "14px 20px 2px" }}>
          Rank locations (lower priority fills first) and set coordinates so orders can ship from the
          nearest location to the buyer. Without coordinates, a location falls back to priority order.
        </p>
        <div className="cd-tablehd" style={{ gridTemplateColumns: GRID }}>
          <span>Location</span>
          <span>Priority</span>
          <span>Latitude</span>
          <span>Longitude</span>
        </div>
        {rows.length === 0 ? (
          <div className="cd-caption" style={{ padding: "0 20px 14px" }}>No locations yet.</div>
        ) : (
          rows.map((l) => (
            <div className="cd-trow" key={l.id} style={{ gridTemplateColumns: GRID }}>
              <div className="cd-row-title truncate">{l.name}</div>
              <div>
                <input
                  className="cd-input tabular-nums" type="number" defaultValue={l.priority}
                  aria-label={`Priority for ${l.name}`}
                  onBlur={(e) => save(l.id, { priority: Math.trunc(Number(e.target.value)) || 0 })}
                />
              </div>
              <div>
                <input
                  className="cd-input tabular-nums" type="number" step="any" defaultValue={l.lat ?? ""} placeholder="—"
                  aria-label={`Latitude for ${l.name}`}
                  onBlur={(e) => save(l.id, { lat: e.target.value === "" ? null : Number(e.target.value) })}
                />
              </div>
              <div>
                <input
                  className="cd-input tabular-nums" type="number" step="any" defaultValue={l.lng ?? ""} placeholder="—"
                  aria-label={`Longitude for ${l.name}`}
                  onBlur={(e) => save(l.id, { lng: e.target.value === "" ? null : Number(e.target.value) })}
                />
              </div>
            </div>
          ))
        )}
      </Card>

      {rows.length > 0 && (
        <Card>
          <SectionTitle>Ship-from addresses</SectionTitle>
          <p className="cd-caption" style={{ marginBottom: 12 }}>
            Used on outbound shipping labels for each location. Leave blank to omit from labels.
          </p>
          <div className="flex flex-col gap-6">
            {rows.map((l) => (
              <div key={l.id} className="flex flex-col gap-2">
                <div className="cd-row-title">{l.name}</div>
                <label className="cd-field">
                  <span>Street address</span>
                  <input
                    className="cd-input"
                    defaultValue={l.street1 ?? ""}
                    placeholder="123 Main St"
                    onBlur={(e) => save(l.id, { street1: e.target.value })}
                  />
                </label>
                <label className="cd-field">
                  <span>Apt, suite, unit (optional)</span>
                  <input
                    className="cd-input"
                    defaultValue={l.street2 ?? ""}
                    placeholder="Suite 4B"
                    onBlur={(e) => save(l.id, { street2: e.target.value })}
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="cd-field">
                    <span>City</span>
                    <input
                      className="cd-input"
                      defaultValue={l.city ?? ""}
                      onBlur={(e) => save(l.id, { city: e.target.value })}
                    />
                  </label>
                  <label className="cd-field">
                    <span>State / region</span>
                    <input
                      className="cd-input"
                      defaultValue={l.region ?? ""}
                      placeholder="ON"
                      onBlur={(e) => save(l.id, { region: e.target.value })}
                    />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="cd-field">
                    <span>Postal code</span>
                    <input
                      className="cd-input"
                      defaultValue={l.postalCode ?? ""}
                      onBlur={(e) => save(l.id, { postalCode: e.target.value })}
                    />
                  </label>
                  <label className="cd-field">
                    <span>Country</span>
                    <input
                      className="cd-input"
                      defaultValue={l.country ?? ""}
                      placeholder="CA"
                      onBlur={(e) => save(l.id, { country: e.target.value })}
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
