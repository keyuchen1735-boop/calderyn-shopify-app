import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import { Card, Btn, Placeholder } from "../ui";
import { CDIcon } from "../icons";
import { ProductsSubTabs } from "../subtabs";

export default function Collections({ app }: { app: DashboardCtx }) {
  const [items, setItems] = useState<client.CollectionVM[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    client
      .fetchCollections()
      .then((c) => {
        if (alive) setItems(c);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof DashboardApiError ? err.message : "Couldn't load collections.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const onCreate = async () => {
    const t = title.trim();
    if (!t || creating) return;
    setCreating(true);
    try {
      const c = await client.createCollection(t);
      setItems((cur) => [c, ...cur]);
      setTitle("");
      app.toast("Collection created.", "check");
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't create the collection.", "warn", "critical");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="cd-screen">
      <header className="cd-screen-head" data-screen-label="Collections">
        <div>
          <h1 className="cd-h1">Collections</h1>
          <p className="cd-sub">
            {loading ? "Loading collections…" : `${items.length} collection${items.length === 1 ? "" : "s"}`}
          </p>
        </div>
      </header>

      <ProductsSubTabs app={app} />

      <div className="flex items-center gap-2.5" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        <input
          className="cd-input"
          placeholder="New collection name"
          aria-label="New collection name"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCreate();
          }}
          style={{ width: "auto", minWidth: 220, flex: "1 1 220px" }}
        />
        <Btn kind="primary" icon="plus" disabled={creating || !title.trim()} onClick={onCreate}>
          Create
        </Btn>
      </div>

      <Card pad={false}>
        {loading ? (
          <Placeholder icon="tag" title="Loading collections" />
        ) : error ? (
          <Placeholder icon="warn" title="Couldn't load collections" sub={error} />
        ) : items.length === 0 ? (
          <Placeholder icon="tag" title="No collections yet" sub="Create one to group products in your storefront." />
        ) : (
          <div className="cd-rows">
            {items.map((c) => (
              <div key={c.id} className="cd-row">
                <CDIcon name="tag" size={16} style={{ color: "var(--text-3)", flexShrink: 0 }} />
                <span className="cd-row-title flex-1 truncate">{c.title}</span>
                <span className="cd-caption tabular-nums">{c.handle}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
