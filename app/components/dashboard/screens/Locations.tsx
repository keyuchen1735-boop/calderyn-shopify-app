import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Card, SectionTitle } from "../ui";
import { ProductsSubTabs } from "../subtabs";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";

// Location settings: rank locations (priority — lower fills first), set map
// coordinates so the allocator can fill orders from the nearest location to
// the buyer, and configure the ship-from address used on outbound labels.
export default function Locations({ app }: { app: DashboardCtx }) {
  const [rows, setRows] = useState<client.LocationVM[]>([]);

  useEffect(() => {
    client.fetchLocations().then(setRows).catch(() => {});
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
    <div className="cd-screen cd-screen--wide">
      <header className="cd-screen-head" data-screen-label="Locations">
        <h1 className="cd-h1">Locations</h1>
      </header>
      <ProductsSubTabs app={app} />
      <Card>
        <p className="cd-caption" style={{ marginBottom: 12 }}>
          Rank locations (lower priority fills first) and set coordinates so orders can ship from the
          nearest location to the buyer. Without coordinates, a location falls back to priority order.
        </p>
        <div className="cd-table-head">
          <span style={{ flex: "1 1 0", minWidth: 140 }}>Location</span>
          <span style={{ width: 100 }}>Priority</span>
          <span style={{ width: 130 }}>Latitude</span>
          <span style={{ width: 130 }}>Longitude</span>
        </div>
        <div className="cd-rows">
          {rows.length === 0 ? (
            <div className="cd-caption" style={{ padding: 8 }}>No locations yet.</div>
          ) : (
            rows.map((l) => (
              <div className="cd-row" key={l.id}>
                <span style={{ flex: "1 1 0", minWidth: 140 }}>{l.name}</span>
                <span style={{ width: 100 }}>
                  <input
                    className="cd-input tabular-nums" type="number" defaultValue={l.priority}
                    onBlur={(e) => save(l.id, { priority: Math.trunc(Number(e.target.value)) || 0 })}
                  />
                </span>
                <span style={{ width: 130 }}>
                  <input
                    className="cd-input tabular-nums" type="number" step="any" defaultValue={l.lat ?? ""} placeholder="—"
                    onBlur={(e) => save(l.id, { lat: e.target.value === "" ? null : Number(e.target.value) })}
                  />
                </span>
                <span style={{ width: 130 }}>
                  <input
                    className="cd-input tabular-nums" type="number" step="any" defaultValue={l.lng ?? ""} placeholder="—"
                    onBlur={(e) => save(l.id, { lng: e.target.value === "" ? null : Number(e.target.value) })}
                  />
                </span>
              </div>
            ))
          )}
        </div>
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
