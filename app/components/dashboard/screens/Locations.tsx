import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Btn, Card, Placeholder, SectionTitle, TableSkeleton } from "../ui";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import { cacheScreenData, cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";

// Location settings: add and deactivate locations, rank them (priority — lower
// fills first), set map coordinates so the allocator can fill orders from the
// nearest location to the buyer, and configure the ship-from address used on
// outbound labels. URL-only page (/dashboard/products/locations): no Products
// subtab entry, so no subtab bar renders here.

const GRID = "2fr 1fr 1fr 1fr auto";

export default function Locations({ app }: { app: DashboardCtx }) {
  // Seeded from the session cache so a return visit paints instantly; the
  // mount fetch below revalidates and writes back through. `null` means the
  // list has never loaded — distinct from a successful empty result, so a
  // failed fetch can never masquerade as "no locations yet".
  const seeded = cachedScreenData<client.LocationVM[]>(SCREEN_CACHE_KEYS.locations);
  const [rows, setRows] = useState<client.LocationVM[] | null>(() => seeded);
  const [loading, setLoading] = useState(() => !seeded);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    client
      .fetchLocations()
      .then((r) => {
        if (!alive) return;
        setRows(cacheScreenData(SCREEN_CACHE_KEYS.locations, r));
        setError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof DashboardApiError ? err.message : "Couldn't load locations.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async (
    id: string,
    patch: Parameters<typeof client.updateLocation>[1],
  ) => {
    try {
      await client.updateLocation(id, patch);
      // Patch the saved row (and the cache) so every input's value-derived key
      // stays truthful: the remounted input re-reads the fresh value, and the
      // next blur's dirty-check compares against what the server now holds.
      setRows((cur) => {
        if (!cur) return cur;
        return cacheScreenData(
          SCREEN_CACHE_KEYS.locations,
          cur.map((l) => (l.id === id ? { ...l, ...patch } : l)),
        );
      });
      app.toast("Location saved.", "check");
    } catch (err) {
      app.toast(
        err instanceof DashboardApiError ? err.message : "Couldn't save the location.",
        "warn",
        "critical",
      );
    }
  };

  // --- add ------------------------------------------------------------------
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);

  const addLocation = async () => {
    const name = newName.trim();
    if (!name || adding) return;
    setAdding(true);
    try {
      const { id } = await client.createLocation({ name });
      setRows((cur) =>
        cacheScreenData(SCREEN_CACHE_KEYS.locations, [
          ...(cur ?? []),
          { id, name, priority: 0, lat: null, lng: null },
        ]),
      );
      setNewName("");
      app.toast("Location added.", "check");
    } catch (err) {
      app.toast(
        err instanceof DashboardApiError ? err.message : "Couldn't add the location.",
        "warn",
        "critical",
      );
    } finally {
      setAdding(false);
    }
  };

  // --- deactivate -------------------------------------------------------------
  const deactivate = async (l: client.LocationVM) => {
    if (!window.confirm(`Deactivate "${l.name}"? It stops filling orders and leaves every picker.`)) {
      return;
    }
    try {
      await client.deactivateLocation(l.id);
      setRows((cur) => {
        if (!cur) return cur;
        return cacheScreenData(
          SCREEN_CACHE_KEYS.locations,
          cur.filter((r) => r.id !== l.id),
        );
      });
      app.toast("Location deactivated.", "check");
    } catch (err) {
      // A 409 here is the stock guard — the server message tells the merchant
      // to move or zero out stock first.
      app.toast(
        err instanceof DashboardApiError ? err.message : "Couldn't deactivate the location.",
        "warn",
        "critical",
      );
    }
  };

  return (
    <div className="cd-screen">
      <header className="cd-screen-head" data-screen-label="Locations">
        <h1 className="cd-h1">Locations</h1>
        <div className="flex items-center gap-2.5">
          <input
            className="cd-input"
            placeholder="New location name"
            aria-label="New location name"
            value={newName}
            maxLength={120}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addLocation();
              }
            }}
            style={{ width: 200 }}
          />
          <Btn kind="primary" icon="plus" disabled={adding || !newName.trim()} onClick={addLocation}>
            Add location
          </Btn>
        </div>
      </header>
      <Card pad={false}>
        <p className="cd-caption" style={{ padding: "14px 20px 2px" }}>
          Rank locations (lower priority fills first) and set coordinates so orders can ship from the
          nearest location to the buyer. Without coordinates, a location falls back to priority order.
        </p>
        {loading && !rows ? (
          <TableSkeleton rows={3} />
        ) : error ? (
          <Placeholder icon="warn" title="Couldn't load locations" sub={error} />
        ) : !rows || rows.length === 0 ? (
          <Placeholder
            icon="box"
            title="No locations yet"
            sub="Add one to start tracking stock."
          />
        ) : (
          // Five columns of inputs can't compress into a phone width — the
          // table pans sideways inside the card instead of crushing the fields.
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 620 }}>
            <div className="cd-tablehd" style={{ gridTemplateColumns: GRID }}>
              <span>Location</span>
              <span>Priority</span>
              <span>Latitude</span>
              <span>Longitude</span>
              <span aria-hidden="true" />
            </div>
            {rows.map((l) => (
              <div className="cd-trow" key={l.id} style={{ gridTemplateColumns: GRID }}>
                <div className="cd-row-title truncate">{l.name}</div>
                <div>
                  <input
                    // Value-derived key so the input REMOUNTS (re-reading defaultValue)
                    // whenever the saved value changes; with the blur dirty-check below,
                    // a no-edit blur never re-submits a stale number.
                    key={`prio:${l.id}:${l.priority}`}
                    className="cd-input tabular-nums" type="number" defaultValue={l.priority}
                    aria-label={`Priority for ${l.name}`}
                    onBlur={(e) => {
                      const next = Math.trunc(Number(e.target.value)) || 0;
                      if (next !== l.priority) save(l.id, { priority: next });
                    }}
                  />
                </div>
                <div>
                  <input
                    key={`lat:${l.id}:${l.lat ?? ""}`}
                    className="cd-input tabular-nums" type="number" step="any" defaultValue={l.lat ?? ""} placeholder="—"
                    aria-label={`Latitude for ${l.name}`}
                    onBlur={(e) => {
                      const raw = e.target.value.trim();
                      const next = raw === "" ? null : Number(raw);
                      if (next !== null && !Number.isFinite(next)) return;
                      if (next !== l.lat) save(l.id, { lat: next });
                    }}
                  />
                </div>
                <div>
                  <input
                    key={`lng:${l.id}:${l.lng ?? ""}`}
                    className="cd-input tabular-nums" type="number" step="any" defaultValue={l.lng ?? ""} placeholder="—"
                    aria-label={`Longitude for ${l.name}`}
                    onBlur={(e) => {
                      const raw = e.target.value.trim();
                      const next = raw === "" ? null : Number(raw);
                      if (next !== null && !Number.isFinite(next)) return;
                      if (next !== l.lng) save(l.id, { lng: next });
                    }}
                  />
                </div>
                <div>
                  <Btn small icon="x" onClick={() => deactivate(l)}>
                    Deactivate
                  </Btn>
                </div>
              </div>
            ))}
            </div>
          </div>
        )}
      </Card>

      {rows !== null && rows.length > 0 && !error && (
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
                    key={`st1:${l.id}:${l.street1 ?? ""}`}
                    className="cd-input"
                    defaultValue={l.street1 ?? ""}
                    placeholder="123 Main St"
                    onBlur={(e) => {
                      if (e.target.value !== (l.street1 ?? "")) save(l.id, { street1: e.target.value });
                    }}
                  />
                </label>
                <label className="cd-field">
                  <span>Apt, suite, unit (optional)</span>
                  <input
                    key={`st2:${l.id}:${l.street2 ?? ""}`}
                    className="cd-input"
                    defaultValue={l.street2 ?? ""}
                    placeholder="Suite 4B"
                    onBlur={(e) => {
                      if (e.target.value !== (l.street2 ?? "")) save(l.id, { street2: e.target.value });
                    }}
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="cd-field">
                    <span>City</span>
                    <input
                      key={`city:${l.id}:${l.city ?? ""}`}
                      className="cd-input"
                      defaultValue={l.city ?? ""}
                      onBlur={(e) => {
                        if (e.target.value !== (l.city ?? "")) save(l.id, { city: e.target.value });
                      }}
                    />
                  </label>
                  <label className="cd-field">
                    <span>State / region</span>
                    <input
                      key={`region:${l.id}:${l.region ?? ""}`}
                      className="cd-input"
                      defaultValue={l.region ?? ""}
                      placeholder="ON"
                      onBlur={(e) => {
                        if (e.target.value !== (l.region ?? "")) save(l.id, { region: e.target.value });
                      }}
                    />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="cd-field">
                    <span>Postal code</span>
                    <input
                      key={`postal:${l.id}:${l.postalCode ?? ""}`}
                      className="cd-input"
                      defaultValue={l.postalCode ?? ""}
                      onBlur={(e) => {
                        if (e.target.value !== (l.postalCode ?? "")) save(l.id, { postalCode: e.target.value });
                      }}
                    />
                  </label>
                  <label className="cd-field">
                    <span>Country</span>
                    <input
                      key={`country:${l.id}:${l.country ?? ""}`}
                      className="cd-input"
                      defaultValue={l.country ?? ""}
                      placeholder="CA"
                      onBlur={(e) => {
                        if (e.target.value !== (l.country ?? "")) save(l.id, { country: e.target.value });
                      }}
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
