import { useEffect, useMemo, useState } from "react";
import type { DashboardCtx } from "../context";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import { buildVariantMatrix } from "~/lib/catalog/variant-matrix";
import { isShippingComplete } from "~/lib/catalog/shipping-dims";
import { Card, Btn, Pill, Placeholder, SectionTitle } from "../ui";
import { CDIcon } from "../icons";
import InventoryPanel from "./InventoryPanel";

// Option values are edited as raw text (not a parsed array) so typing the comma
// separator doesn't fight a controlled input. The array is derived on demand.
type Opt = { name: string; valuesText: string };

function parseOptions(opts: Opt[]): Array<{ name: string; values: string[] }> {
  return opts
    .map((o) => ({
      name: o.name.trim(),
      values: o.valuesText.split(",").map((s) => s.trim()).filter(Boolean),
    }))
    .filter((o) => o.name && o.values.length);
}

function variantLabel(v: client.VariantDraft): string {
  return (v.optionValues ?? []).join(" / ") || "Default";
}

// Price is stored in cents but edited in dollars (merchant-facing). Empty -> undefined.
function centsToDollars(cents?: number): string {
  return cents == null ? "" : String(cents / 100);
}
function dollarsToCents(text: string): number | undefined {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

export default function ProductEditor({ app }: { app: DashboardCtx }) {
  const id = app.nav.param && app.nav.param !== "new" ? app.nav.param : null;

  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<"draft" | "active" | "archived">("draft");
  const [vendor, setVendor] = useState("");
  const [tags, setTags] = useState("");
  const [description, setDescription] = useState("");
  // Round-tripped, not surfaced as a field: keep a promoted product's category
  // instead of nulling it on every save.
  const [category, setCategory] = useState<string | null>(null);
  const [options, setOptions] = useState<Opt[]>([]);
  const [variants, setVariants] = useState<client.VariantDraft[]>([{ optionValues: [] }]);
  const [media, setMedia] = useState<Array<{ id: string; url: string; isPrimary: boolean }>>([]);
  const [collections, setCollections] = useState<client.CollectionVM[]>([]);
  const [selectedCollections, setSelectedCollections] = useState<string[]>([]);
  const [loading, setLoading] = useState(Boolean(id));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [collectionsError, setCollectionsError] = useState(false);

  useEffect(() => {
    setCollectionsError(false);
    client.fetchCollections().then(setCollections).catch(() => setCollectionsError(true));
  }, []);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setLoading(true);
    setLoadError(null);
    client
      .fetchProduct(id)
      .then((p) => {
        if (!alive) return;
        setTitle(p.title);
        setStatus(p.status);
        setVendor(p.vendor ?? "");
        setCategory(p.category ?? null);
        setTags((p.tags ?? []).join(", "));
        setDescription(p.description ?? "");
        setOptions((p.options ?? []).map((o) => ({ name: o.name, valuesText: o.values.join(", ") })));
        setVariants(p.variants.length ? p.variants : [{ optionValues: [] }]);
        setMedia(p.media);
        setSelectedCollections(p.collectionIds ?? []);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setLoadError(err instanceof DashboardApiError ? err.message : "Couldn't load this product.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  // Regenerate the variant grid whenever options change, preserving entered data.
  const regen = (next: Opt[]) => {
    setOptions(next);
    setVariants((cur) => buildVariantMatrix(parseOptions(next), cur));
  };

  const setVariantField = (i: number, patch: Partial<client.VariantDraft>) => {
    setVariants((cur) => cur.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  };

  const onUpload = async (file: File) => {
    // The file input is only rendered once the product exists; this guard just
    // narrows id to a string for uploadProductImage (the "save first" guidance is
    // the always-rendered caption below).
    if (!id) return;
    try {
      const m = await client.uploadProductImage(id, file);
      setMedia((cur) => [...cur, { id: m.id, url: m.url, isPrimary: cur.length === 0 }]);
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Upload failed.", "warn", "critical");
    }
  };

  const onRemoveImage = async (mediaId: string) => {
    try {
      await client.deleteProductImage(mediaId);
      setMedia((cur) => cur.filter((m) => m.id !== mediaId));
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't remove the image.", "warn", "critical");
    }
  };

  const onSave = async () => {
    if (!title.trim()) {
      app.toast("Add a product title.", "warn");
      return;
    }
    setSaving(true);
    try {
      const draft: client.ProductDraft = {
        title: title.trim(),
        status,
        vendor: vendor.trim() || undefined,
        category: category ?? undefined,
        description: description.trim() || undefined,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        options: parseOptions(options),
        variants,
        collectionIds: selectedCollections,
      };
      await client.saveProduct(draft, id ?? undefined);
      app.toast("Product saved.", "check");
      app.navigate("catalog");
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't save the product.", "warn", "critical");
    } finally {
      setSaving(false);
    }
  };

  const onArchive = async () => {
    if (!id) return;
    try {
      await client.archiveProduct(id);
      app.toast("Product archived.", "check");
      app.navigate("catalog");
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't archive the product.", "warn", "critical");
    }
  };

  const showStock = useMemo(() => variants.some((v) => v.inventoryTracked !== false), [variants]);

  return (
    <div className="cd-screen" data-screen-label="Product editor">
      <button className="cd-back" onClick={() => app.navigate("catalog")}>
        <CDIcon name="chevronLeft" size={15} />
        Products
      </button>
      <header className="cd-screen-head" style={{ marginTop: 4 }}>
        <div>
          <h1 className="cd-h1">{id ? "Edit product" : "New product"}</h1>
        </div>
        <div className="flex items-center gap-2.5">
          {id && (
            <Btn icon="archive" disabled={saving} onClick={onArchive}>
              Archive
            </Btn>
          )}
          <Btn kind="primary" icon="check" disabled={saving} onClick={onSave}>
            {saving ? "Saving…" : "Save"}
          </Btn>
        </div>
      </header>

      {loading ? (
        <Card>
          <Placeholder icon="bag" title="Loading product…" />
        </Card>
      ) : loadError ? (
        <Card>
          <Placeholder icon="warn" title="Couldn't load this product" sub={loadError} />
        </Card>
      ) : (
        <>
          <Card>
            <div className="flex flex-col gap-3">
              <label className="cd-field">
                <span>Title</span>
                <input className="cd-input" value={title} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="cd-field">
                  <span>Status</span>
                  <select className="cd-input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                    <option value="draft">Draft</option>
                    <option value="active">Active</option>
                    <option value="archived">Archived</option>
                  </select>
                </label>
                <label className="cd-field">
                  <span>Vendor</span>
                  <input className="cd-input" value={vendor} onChange={(e) => setVendor(e.target.value)} />
                </label>
              </div>
              <label className="cd-field">
                <span>Tags (comma-separated)</span>
                <input className="cd-input" value={tags} onChange={(e) => setTags(e.target.value)} />
              </label>
              <label className="cd-field">
                <span>Description</span>
                <textarea className="cd-input" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
              </label>
            </div>
          </Card>

          <Card>
            <SectionTitle>Images</SectionTitle>
            {!id && <p className="cd-caption" style={{ marginBottom: 10 }}>Save the product first, then add images.</p>}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {media.map((m) => (
                <div
                  key={m.id}
                  style={{ position: "relative", width: 96, height: 96, borderRadius: 10, overflow: "hidden", background: "var(--gray-bg)" }}
                >
                  <img src={m.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  {m.isPrimary && (
                    <span style={{ position: "absolute", top: 4, left: 4 }}>
                      <Pill tone="accent">Main</Pill>
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => onRemoveImage(m.id)}
                    aria-label="Remove image"
                    style={{
                      position: "absolute",
                      top: 4,
                      right: 4,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 22,
                      height: 22,
                      borderRadius: 999,
                      border: 0,
                      cursor: "pointer",
                      background: "color-mix(in oklch, black 55%, transparent)",
                      color: "white",
                    }}
                  >
                    <CDIcon name="x" size={13} strokeWidth={2.2} />
                  </button>
                </div>
              ))}
              {id && (
                <label
                  style={{
                    width: 96,
                    height: 96,
                    borderRadius: 10,
                    border: "1px dashed var(--hairline-strong)",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 4,
                    cursor: "pointer",
                    color: "var(--text-2)",
                  }}
                >
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onUpload(f);
                      e.target.value = "";
                    }}
                  />
                  <CDIcon name="plus" size={18} />
                  <span className="cd-caption">Add image</span>
                </label>
              )}
            </div>
          </Card>

          <Card>
            <SectionTitle>Options</SectionTitle>
            <p className="cd-caption" style={{ marginBottom: 10 }}>
              Add options like Size or Color to generate a variant per combination.
            </p>
            <div className="flex flex-col gap-2">
              {options.map((o, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    className="cd-input"
                    placeholder="Option name (e.g. Size)"
                    value={o.name}
                    onChange={(e) => regen(options.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    style={{ flex: "0 0 180px" }}
                  />
                  <input
                    className="cd-input"
                    placeholder="Values, comma-separated (S, M, L)"
                    value={o.valuesText}
                    onChange={(e) => regen(options.map((x, j) => (j === i ? { ...x, valuesText: e.target.value } : x)))}
                    style={{ flex: "1 1 0" }}
                  />
                  <Btn small onClick={() => regen(options.filter((_, j) => j !== i))}>
                    Remove
                  </Btn>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10 }}>
              <Btn small icon="plus" onClick={() => regen([...options, { name: "", valuesText: "" }])}>
                Add option
              </Btn>
            </div>
          </Card>

          <Card>
            <SectionTitle>Variants</SectionTitle>
            <div className="flex flex-col gap-2">
              <div className="cd-caption" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ flex: "1 1 0", minWidth: 120 }}>Variant</span>
                <span style={{ width: 150 }}>SKU</span>
                <span style={{ width: 110, textAlign: "right" }}>Price ($)</span>
                {showStock && !id && <span style={{ width: 90, textAlign: "right" }}>Stock</span>}
              </div>
              {variants.map((v, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className="cd-row-title truncate" style={{ flex: "1 1 0", minWidth: 120 }}>
                      {variantLabel(v)}
                    </span>
                    <input
                      className="cd-input"
                      placeholder="SKU"
                      aria-label={`SKU for ${variantLabel(v)}`}
                      value={v.sku ?? ""}
                      onChange={(e) => setVariantField(i, { sku: e.target.value })}
                      style={{ width: 150 }}
                    />
                    <input
                      className="cd-input tabular-nums"
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      aria-label={`Price for ${variantLabel(v)}`}
                      value={centsToDollars(v.retailPriceCents)}
                      onChange={(e) => setVariantField(i, { retailPriceCents: dollarsToCents(e.target.value) })}
                      style={{ width: 110, textAlign: "right" }}
                    />
                    {showStock && !id && (
                      <input
                        className="cd-input tabular-nums"
                        type="number"
                        min="0"
                        step="1"
                        inputMode="numeric"
                        aria-label={`Stock for ${variantLabel(v)}`}
                        value={v.inventoryOnHand ?? ""}
                        onChange={(e) =>
                          setVariantField(i, {
                            inventoryOnHand: e.target.value === "" ? undefined : Math.max(0, Math.trunc(Number(e.target.value) || 0)),
                          })
                        }
                        style={{ width: 90, textAlign: "right" }}
                      />
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", paddingLeft: 4 }}>
                    <span className="cd-caption" style={{ width: 66 }}>Shipping</span>
                    <input
                      className="cd-input tabular-nums"
                      type="number"
                      min="0"
                      step="1"
                      inputMode="numeric"
                      aria-label={`Weight in grams for ${variantLabel(v)}`}
                      placeholder="Weight g"
                      value={v.grams ?? ""}
                      onChange={(e) =>
                        setVariantField(i, { grams: e.target.value === "" ? undefined : Math.trunc(Number(e.target.value)) || undefined })
                      }
                      style={{ width: 96, textAlign: "right" }}
                    />
                    {(["lengthMm", "widthMm", "heightMm"] as const).map((axis) => (
                      <input
                        key={axis}
                        className="cd-input tabular-nums"
                        type="number"
                        min="0"
                        step="1"
                        inputMode="numeric"
                        aria-label={`${axis.replace("Mm", "")} in millimetres for ${variantLabel(v)}`}
                        placeholder={`${axis.replace("Mm", "").toUpperCase()} mm`}
                        value={v[axis] ?? ""}
                        onChange={(e) =>
                          setVariantField(i, { [axis]: e.target.value === "" ? undefined : Math.trunc(Number(e.target.value)) || undefined })
                        }
                        style={{ width: 84, textAlign: "right" }}
                      />
                    ))}
                    {!isShippingComplete({ grams: v.grams, lengthMm: v.lengthMm, widthMm: v.widthMm, heightMm: v.heightMm }) && (
                      <span className="cd-caption" style={{ color: "var(--cd-warning, #b45309)" }}>
                        Incomplete — rates estimated
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <p className="cd-caption" style={{ marginTop: 10 }}>
              {id
                ? "Manage live stock per location in the section below."
                : "Stock is a starting on-hand count. Per-location availability opens once the product is saved."}
            </p>
          </Card>

          {id && showStock && variants.some((v) => v.id) && (
            <Card>
              <SectionTitle>Stock by location</SectionTitle>
              <div className="flex flex-col gap-4">
                {variants
                  .filter((v) => v.id)
                  .map((v) => (
                    <div key={v.id}>
                      <div className="cd-row-title" style={{ marginBottom: 6 }}>{variantLabel(v)}</div>
                      <InventoryPanel app={app} variantId={v.id as string} />
                    </div>
                  ))}
              </div>
            </Card>
          )}

          <Card>
            <SectionTitle>Collections</SectionTitle>
            {collectionsError ? (
              <p className="cd-caption">Couldn&apos;t load collections. Reopen this product to try again.</p>
            ) : collections.length === 0 ? (
              <p className="cd-caption">No collections yet. Create one on the Collections screen.</p>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {collections.map((c) => {
                  const on = selectedCollections.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className="cd-badge"
                      onClick={() =>
                        setSelectedCollections((cur) => (on ? cur.filter((x) => x !== c.id) : [...cur, c.id]))
                      }
                      style={{
                        cursor: "pointer",
                        border: `1px solid ${on ? "var(--accent)" : "var(--hairline-strong)"}`,
                        background: on ? "var(--accent-bg)" : "transparent",
                        color: on ? "var(--accent)" : "var(--text-2)",
                      }}
                    >
                      {on && <CDIcon name="check" size={12} strokeWidth={2} />}
                      {c.title}
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
