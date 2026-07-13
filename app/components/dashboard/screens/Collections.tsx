import { useEffect, useRef, useState } from "react";
import type { DashboardCtx } from "../context";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import { cacheScreenData, cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import { Card, Btn, ClearableSearchInput, Pan, Pill, Placeholder, SectionTitle, TableSkeleton } from "../ui";
import { CDIcon } from "../icons";

// URL-only pages (/dashboard/products/collections[/<id>]): no Products subtab
// entry, so no subtab bar renders here. app.nav.param routes between the list
// and a single collection's detail view.

const GRID = "2fr 1fr 0.6fr auto";
const MEMBER_GRID = "44px 2fr 1fr auto";

const STATUS_TONE: Record<string, "success" | "neutral" | "warn"> = {
  active: "success",
  draft: "neutral",
  archived: "warn",
};

/** Patch the cached collections list (when present) so a back-navigation paints
 *  the count the detail view just changed, instead of the stale snapshot. */
function bumpCachedCount(collectionId: string, delta: number): void {
  const cached = cachedScreenData<client.CollectionVM[]>(SCREEN_CACHE_KEYS.collections);
  if (!cached) return;
  cacheScreenData(
    SCREEN_CACHE_KEYS.collections,
    cached.map((c) =>
      c.id === collectionId ? { ...c, productCount: Math.max(0, c.productCount + delta) } : c,
    ),
  );
}

export default function Collections({ app }: { app: DashboardCtx }) {
  if (app.nav.param) return <CollectionDetail app={app} id={app.nav.param} />;
  return <CollectionsList app={app} />;
}

function CollectionsList({ app }: { app: DashboardCtx }) {
  // Seeded from the session cache so a return visit paints instantly; the
  // mount fetch below revalidates and writes back through.
  const seeded = cachedScreenData<client.CollectionVM[]>(SCREEN_CACHE_KEYS.collections);
  const [items, setItems] = useState<client.CollectionVM[]>(() => seeded ?? []);
  const [loading, setLoading] = useState(() => !seeded);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  // Row whose title cell is currently an input; value tracks the draft text.
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    client
      .fetchCollections()
      .then((c) => {
        cacheScreenData(SCREEN_CACHE_KEYS.collections, c);
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
      // Write the optimistic insert through the cache too, so navigating away
      // and back can't briefly resurrect the pre-create list.
      setItems((cur) => cacheScreenData(SCREEN_CACHE_KEYS.collections, [c, ...cur]));
      setTitle("");
      app.toast("Collection created.", "check");
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't create the collection.", "warn", "critical");
    } finally {
      setCreating(false);
    }
  };

  const commitRename = async () => {
    if (!editing) return;
    const { id, value } = editing;
    setEditing(null);
    const next = value.trim();
    const row = items.find((c) => c.id === id);
    if (!row || !next || next === row.title) return;
    // Optimistic: the row (and the cache) rename immediately; a failed write
    // rolls both back so the list never lies about what the server holds.
    const snapshot = items;
    setItems((cur) => cacheScreenData(SCREEN_CACHE_KEYS.collections, cur.map((c) => (c.id === id ? { ...c, title: next } : c))));
    try {
      await client.renameCollection(id, next);
    } catch (err) {
      setItems(cacheScreenData(SCREEN_CACHE_KEYS.collections, snapshot));
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't rename the collection.", "warn", "critical");
    }
  };

  const onDelete = async (c: client.CollectionVM) => {
    if (busyId) return;
    if (!window.confirm(`Delete "${c.title}"? Products stay; they just leave this collection.`)) return;
    setBusyId(c.id);
    try {
      await client.deleteCollection(c.id);
      setItems((cur) => cacheScreenData(SCREEN_CACHE_KEYS.collections, cur.filter((x) => x.id !== c.id)));
      app.toast("Collection deleted.", "check");
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't delete the collection.", "warn", "critical");
    } finally {
      setBusyId(null);
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
          <TableSkeleton />
        ) : error ? (
          <Placeholder icon="warn" title="Couldn't load collections" sub={error} />
        ) : items.length === 0 ? (
          <Placeholder icon="tag" title="No collections yet" sub="Create one to group products in your storefront." />
        ) : (
          <Pan min={560}>
            <div className="cd-tablehd" style={{ gridTemplateColumns: GRID }}>
              <span>Collection</span>
              <span>Handle</span>
              <span>Products</span>
              <span aria-hidden="true" />
            </div>
            {items.map((c) => (
              // Div-with-button-semantics rather than a real <button>: the row
              // nests the rename input and action buttons, which are invalid
              // inside <button>.
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                className="cd-trow"
                onClick={() => app.navigate("collections", c.id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    app.navigate("collections", c.id);
                  }
                }}
                style={{ gridTemplateColumns: GRID, cursor: "pointer" }}
              >
                {editing?.id === c.id ? (
                  <div onClick={(e) => e.stopPropagation()}>
                    <input
                      className="cd-input"
                      aria-label={`Rename ${c.title}`}
                      value={editing.value}
                      autoFocus
                      onChange={(e) => setEditing({ id: c.id, value: e.target.value })}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setEditing(null);
                      }}
                      style={{ width: "100%", maxWidth: 320 }}
                    />
                  </div>
                ) : (
                  <div className="cd-row-title truncate">{c.title}</div>
                )}
                <div className="cd-caption tabular-nums truncate">{c.handle}</div>
                <div className="cd-row-num tabular-nums">{c.productCount}</div>
                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <Btn
                    small
                    icon="edit"
                    disabled={busyId === c.id}
                    onClick={() => setEditing({ id: c.id, value: c.title })}
                  >
                    Rename
                  </Btn>
                  <Btn small icon="trash" disabled={busyId === c.id} onClick={() => onDelete(c)}>
                    Delete
                  </Btn>
                </div>
              </div>
            ))}
          </Pan>
        )}
      </Card>
    </div>
  );
}

function CollectionDetail({ app, id }: { app: DashboardCtx; id: string }) {
  // Live-fetch only — the detail view has no cache key; the LIST keeps seeding
  // SCREEN_CACHE_KEYS.collections and gets count patches written through.
  const [collectionTitle, setCollectionTitle] = useState<string | null>(() => {
    const cached = cachedScreenData<client.CollectionVM[]>(SCREEN_CACHE_KEYS.collections);
    return cached?.find((c) => c.id === id)?.title ?? null;
  });
  const [members, setMembers] = useState<client.CollectionProductVM[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setMembers(null);
    setMembersError(null);
    client
      .fetchCollectionProducts(id)
      .then((p) => {
        if (alive) setMembers(p);
      })
      .catch((err: unknown) => {
        if (alive) setMembersError(err instanceof DashboardApiError ? err.message : "Couldn't load this collection.");
      });
    // The title rides the collections list fetch — it may already be cached,
    // but revalidate so a rename from another tab still paints correctly.
    client
      .fetchCollections()
      .then((all) => {
        if (!alive) return;
        const hit = all.find((c) => c.id === id);
        if (hit) setCollectionTitle(hit.title);
      })
      .catch(() => {
        // Title is cosmetic here; the members fetch above carries the real
        // error surface (a missing collection 404s there).
      });
    return () => {
      alive = false;
    };
  }, [id]);

  // --- add-products search ----------------------------------------------------
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const [results, setResults] = useState<client.ProductSummaryVM[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  // Latest query identity, read after an async search lands to drop a stale
  // response that raced a newer keystroke.
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    if (!query) {
      setResults(null);
      setSearching(false);
      setSearchError(null);
      return;
    }
    let alive = true;
    setSearching(true);
    setSearchError(null);
    client
      .fetchProducts({ search: query })
      .then((r) => {
        if (!alive || queryRef.current !== query) return;
        setResults(r.products);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setSearchError(err instanceof DashboardApiError ? err.message : "Couldn't search products.");
      })
      .finally(() => {
        if (alive) setSearching(false);
      });
    return () => {
      alive = false;
    };
  }, [query]);

  const onRemove = async (m: client.CollectionProductVM) => {
    if (removing || !members) return;
    setRemoving(m.id);
    const snapshot = members;
    setMembers(members.filter((x) => x.id !== m.id));
    try {
      await client.removeFromCollection(id, m.id);
      bumpCachedCount(id, -1);
    } catch (err) {
      setMembers(snapshot);
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't remove the product.", "warn", "critical");
    } finally {
      setRemoving(null);
    }
  };

  const onAdd = async (p: client.ProductSummaryVM) => {
    if (adding) return;
    setAdding(p.id);
    try {
      await client.addToCollection(id, p.id);
      setMembers((cur) => [
        ...(cur ?? []),
        { id: p.id, title: p.title, status: p.status, imageUrl: p.imageUrl },
      ]);
      bumpCachedCount(id, 1);
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't add the product.", "warn", "critical");
    } finally {
      setAdding(null);
    }
  };

  const memberIds = new Set((members ?? []).map((m) => m.id));
  const candidates = (results ?? []).filter((p) => !memberIds.has(p.id));

  return (
    <div className="cd-screen" data-screen-label="Collection detail">
      <button className="cd-back" onClick={() => app.navigate("collections")}>
        <CDIcon name="chevronLeft" size={15} />
        Collections
      </button>
      <header className="cd-screen-head" style={{ marginTop: 4 }}>
        <div>
          <h1 className="cd-h1">{collectionTitle ?? "Collection"}</h1>
          <p className="cd-sub">
            {members === null && !membersError
              ? "Loading products…"
              : `${members?.length ?? 0} product${(members?.length ?? 0) === 1 ? "" : "s"} in this collection`}
          </p>
        </div>
      </header>

      <Card pad={false}>
        {members === null && !membersError ? (
          <TableSkeleton />
        ) : membersError ? (
          <Placeholder icon="warn" title="Couldn't load this collection" sub={membersError} />
        ) : members && members.length === 0 ? (
          <Placeholder icon="tag" title="No products yet" sub="Search your catalog below to add products." />
        ) : (
          <Pan min={480}>
            <div className="cd-tablehd" style={{ gridTemplateColumns: MEMBER_GRID }}>
              <span aria-hidden="true" />
              <span>Product</span>
              <span>Status</span>
              <span aria-hidden="true" />
            </div>
            {(members ?? []).map((m) => (
              <div key={m.id} className="cd-trow" style={{ gridTemplateColumns: MEMBER_GRID }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 8,
                    overflow: "hidden",
                    background: "var(--gray-bg)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {m.imageUrl ? (
                    <img src={m.imageUrl} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <CDIcon name="bag" size={15} />
                  )}
                </div>
                <div className="cd-row-title truncate">{m.title}</div>
                <div>
                  <Pill tone={STATUS_TONE[m.status] ?? "neutral"}>{m.status}</Pill>
                </div>
                <div>
                  <Btn small icon="x" disabled={removing === m.id} onClick={() => onRemove(m)}>
                    Remove
                  </Btn>
                </div>
              </div>
            ))}
          </Pan>
        )}
      </Card>

      <div style={{ marginTop: 18 }}>
        <SectionTitle>Add products</SectionTitle>
        <div style={{ maxWidth: 360, marginBottom: 10 }}>
          <ClearableSearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search your catalog"
            ariaLabel="Search products to add"
          />
        </div>
        {query && (
          <Card pad={false}>
            {searching ? (
              <TableSkeleton rows={3} />
            ) : searchError ? (
              <Placeholder icon="warn" title="Couldn't search products" sub={searchError} />
            ) : candidates.length === 0 ? (
              <Placeholder
                icon="search"
                title="No matching products"
                sub="Anything already in this collection is hidden from results."
              />
            ) : (
              <Pan min={480}>
                {candidates.map((p) => (
                <div key={p.id} className="cd-trow" style={{ gridTemplateColumns: MEMBER_GRID }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      overflow: "hidden",
                      background: "var(--gray-bg)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {p.imageUrl ? (
                      <img src={p.imageUrl} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    ) : (
                      <CDIcon name="bag" size={15} />
                    )}
                  </div>
                  <div className="cd-row-title truncate">{p.title}</div>
                  <div>
                    <Pill tone={STATUS_TONE[p.status] ?? "neutral"}>{p.status}</Pill>
                  </div>
                  <div>
                    <Btn small icon="plus" disabled={adding === p.id} onClick={() => onAdd(p)}>
                      Add
                    </Btn>
                  </div>
                </div>
                ))}
              </Pan>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
