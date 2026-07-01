import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Card } from "../ui";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";

// Location settings: rank locations (priority — lower fills first) and set map
// coordinates so the allocator can fill orders from the nearest location to the
// buyer. Both feed the allocator; coordinates are optional (without them a
// location falls back to priority order).
export default function Locations({ app }: { app: DashboardCtx }) {
  const [rows, setRows] = useState<client.LocationVM[]>([]);

  useEffect(() => {
    client.fetchLocations().then(setRows).catch(() => {});
  }, []);

  const save = async (id: string, patch: { priority?: number; lat?: number | null; lng?: number | null }) => {
    try {
      await client.updateLocation(id, patch);
      app.toast("Location saved.", "check");
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't save the location.", "warn", "critical");
    }
  };

  return (
    <div className="cd-screen cd-screen--wide">
      <header className="cd-screen-head" data-screen-label="Locations">
        <h1 className="cd-h1">Locations</h1>
      </header>
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
    </div>
  );
}
