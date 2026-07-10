import { useEffect, useMemo, useState } from "react";
import type { DashboardCtx } from "../context";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import { buildVariantMatrix } from "~/lib/catalog/variant-matrix";
import { centsToDollars, dollarsToCents, parseOptionRows } from "~/lib/catalog/product-form";
import { PRODUCT_HANDLE_RE, PRODUCT_HANDLE_MAX } from "~/lib/catalog/handle";
import {
  SEO_TITLE_SOFT_MAX,
  SEO_DESCRIPTION_SOFT_MAX,
  SEO_TITLE_MAX,
  SEO_DESCRIPTION_MAX,
} from "~/lib/catalog/types";
import { Card, Btn, Pill, Placeholder, SectionTitle } from "../ui";
import { CDIcon } from "../icons";
import InventoryPanel from "./InventoryPanel";
import NewProductFlow from "./NewProductFlow";

// Option values are edited as raw text (not a parsed array) so typing the comma
// separator doesn't fight a controlled input. The array is derived on demand
// via the shared parseOptionRows (same converter the new-product flow uses).
type Opt = { name: string; valuesText: string };

function parseOptions(opts: Opt[]): Array<{ name: string; values: string[] }> {
  return parseOptionRows(opts.map((o) => ({ name: o.name, values: o.valuesText })));
}

function variantLabel(v: client.VariantDraft): string {
  return (v.optionValues ?? []).join(" / ") || "Default";
}

type MediaVM = client.ProductDetailVM["media"][number];

function parseRestrictedCountries(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length === 2);
}

function restrictedCountriesText(codes?: string[]): string {
  return (codes ?? []).join(", ");
}

// In-field character counter against the advisory search-result lengths, same
// pattern as the Search screen's store-description field (.cd-seo__inputwrap +
// .cd-seo__count); the over-limit state borrows the existing warning token.
function CharCounter({ length, max }: { length: number; max: number }) {
  return (
    <span className="cd-seo__count" aria-hidden="true" style={length > max ? { color: "var(--orange)" } : undefined}>
      {length}/{max}
    </span>
  );
}

// Creating a product goes through the prompt-first stepped flow; this editor
// remains the edit surface (media, per-variant SKUs/shipping, live stock).
export default function ProductEditor({ app }: { app: DashboardCtx }) {
  const isNew = !app.nav.param || app.nav.param === "new";
  if (isNew) return <NewProductFlow app={app} />;
  return <ProductEditorEdit app={app} />;
}

function ProductEditorEdit({ app }: { app: DashboardCtx }) {
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
  // Search-listing card: the handle as edited, the saved one (only a real
  // change is submitted), the override fields, and the server-built defaults.
  const [handle, setHandle] = useState("");
  const [savedHandle, setSavedHandle] = useState("");
  const [metaTitle, setMetaTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [seoListing, setSeoListing] = useState<client.SeoListingVM | null>(null);
  const [media, setMedia] = useState<MediaVM[]>([]);
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
        setHandle(p.handle);
        setSavedHandle(p.handle);
        setSeoListing(p.seoListing);
        setMetaTitle(p.seoListing?.metaTitle ?? "");
        setMetaDescription(p.seoListing?.metaDescription ?? "");
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
      // Mirror the server's placement: the new image lands last (position = count
      // of images shown here) and is primary only when it is the first one.
      setMedia((cur) => [...cur, { id: m.id, url: m.url, isPrimary: cur.length === 0, alt: null, position: cur.length }]);
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Upload failed.", "warn", "critical");
    }
  };

  // Media management handlers are optimistic (the gallery reflects the intent
  // immediately) and roll back to the pre-call snapshot + toast on failure.
  const onMakeMain = async (mediaId: string) => {
    const snapshot = media;
    setMedia((cur) => cur.map((m) => ({ ...m, isPrimary: m.id === mediaId })));
    try {
      await client.setPrimaryProductImage(mediaId);
    } catch (err) {
      setMedia(snapshot);
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't set the main image.", "warn", "critical");
    }
  };

  const onMoveImage = async (mediaId: string, dir: "up" | "down") => {
    const snapshot = media;
    // Same reorder rule as the server: swap with the neighbor in position order,
    // then renumber by index so duplicate legacy positions self-heal.
    const ordered = [...media].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const idx = ordered.findIndex((m) => m.id === mediaId);
    const j = dir === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || j < 0 || j >= ordered.length) return; // edge — nothing to swap with
    [ordered[idx], ordered[j]] = [ordered[j], ordered[idx]];
    setMedia(ordered.map((m, i) => ({ ...m, position: i })));
    try {
      await client.moveProductImage(mediaId, dir);
    } catch (err) {
      setMedia(snapshot);
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't reorder the images.", "warn", "critical");
    }
  };

  const onSetImageAlt = async (mediaId: string, raw: string) => {
    const next = raw.trim() || null;
    const current = media.find((m) => m.id === mediaId);
    if (!current || current.alt === next) return; // only commit a real change
    const snapshot = media;
    setMedia((cur) => cur.map((m) => (m.id === mediaId ? { ...m, alt: next } : m)));
    try {
      await client.setProductImageAlt(mediaId, next);
    } catch (err) {
      setMedia(snapshot);
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't save the alt text.", "warn", "critical");
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
    // Only a real handle edit is submitted; an emptied field keeps the saved
    // address (there is always a page address, so blank means "no change").
    // `handle` is already normalized — the input's onChange sanitizer is the
    // single normalization point.
    const handleChanged = Boolean(handle) && handle !== savedHandle;
    if (handleChanged && !PRODUCT_HANDLE_RE.test(handle)) {
      app.toast("Page address can use only lowercase letters, numbers, and hyphens.", "warn");
      return;
    }
    // Submit `seo` only when the merchant actually changed it against the
    // loaded baseline: an unrelated save must not rewrite (or, from a stale
    // tab, clobber) the stored override — and when the listing failed to load
    // (seoListing null) a blind write could wipe an override we never showed.
    const seoChanged =
      seoListing !== null &&
      (metaTitle.trim() !== (seoListing.metaTitle ?? "") ||
        metaDescription.trim() !== (seoListing.metaDescription ?? ""));
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
        ...(handleChanged ? { handle } : {}),
        ...(seoChanged ? { seo: { metaTitle: metaTitle.trim(), metaDescription: metaDescription.trim() } } : {}),
      };
      await client.saveProduct(draft, id ?? undefined);
      app.toast("Product saved.", "check");
      app.navigate("catalog");
    } catch (err) {
      if (err instanceof DashboardApiError && err.code === "incomplete_shipping") {
        app.toast("Add size and weight before this product can go live.", "warn", "critical");
      } else if (err instanceof DashboardApiError && err.code === "invalid_handle") {
        app.toast("Page address can use only lowercase letters, numbers, and hyphens.", "warn", "critical");
      } else if (err instanceof DashboardApiError && err.code === "handle_conflict") {
        app.toast("That URL is already used by another product.", "warn", "critical");
      } else if (err instanceof DashboardApiError && err.code === "editing_conflict") {
        app.toast("This product's address was just changed somewhere else. Reload it and try again.", "warn", "critical");
      } else {
        app.toast(err instanceof DashboardApiError ? err.message : "Couldn't save the product.", "warn", "critical");
      }
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

  // Search-listing card derivations. seoListing is null when its server reads
  // failed — the meta fields render disabled (a blind edit could clobber an
  // override that never loaded) and onSave omits `seo` from the payload.
  const seoUnavailable = seoListing === null;
  const urlPrefix = seoListing?.urlPrefix ?? "/storefront/products/";
  const previewTitle = metaTitle.trim() || seoListing?.defaultTitle || title;
  const previewDescription = metaDescription.trim() || seoListing?.defaultDescription || "";
  const previewUrl = `${urlPrefix}${handle || savedHandle}`;

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
            <SectionTitle>Search listing</SectionTitle>
            <p className="cd-caption" style={{ marginBottom: 10 }}>
              How this product shows up in search results, and its address on your store.
            </p>
            {seoUnavailable && (
              <p className="cd-caption" role="status" style={{ marginBottom: 10 }}>
                Search settings couldn't be loaded right now, so they can't be edited. Your saved
                settings are unchanged — reload to try again.
              </p>
            )}
            <div className="flex flex-col gap-3">
              <label className="cd-field">
                <span>Page address</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    className="cd-caption"
                    title={urlPrefix}
                    style={{ flex: "0 1 auto", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    {urlPrefix}
                  </span>
                  <input
                    className="cd-input"
                    maxLength={PRODUCT_HANDLE_MAX}
                    value={handle}
                    aria-label="Page address"
                    onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""))}
                    style={{ flex: "1 1 0", minWidth: 120 }}
                  />
                </div>
                <span className="cd-caption">Changing the address redirects the old link to the new one.</span>
              </label>
              <label className="cd-field">
                <span>Search title</span>
                <div className="cd-seo__inputwrap" style={{ width: "100%" }}>
                  <input
                    className="cd-input"
                    maxLength={SEO_TITLE_MAX}
                    value={metaTitle}
                    placeholder={seoListing?.defaultTitle ?? ""}
                    disabled={seoUnavailable}
                    onChange={(e) => setMetaTitle(e.target.value)}
                    style={{ flex: "1 1 0", paddingRight: 58 }}
                  />
                  <CharCounter length={metaTitle.length} max={SEO_TITLE_SOFT_MAX} />
                </div>
              </label>
              <label className="cd-field">
                <span>Search description</span>
                <div className="cd-seo__inputwrap" style={{ width: "100%" }}>
                  <textarea
                    className="cd-input"
                    rows={2}
                    maxLength={SEO_DESCRIPTION_MAX}
                    value={metaDescription}
                    placeholder={seoListing?.defaultDescription ?? ""}
                    disabled={seoUnavailable}
                    onChange={(e) => setMetaDescription(e.target.value)}
                    style={{ flex: "1 1 0", paddingRight: 58 }}
                  />
                  <CharCounter length={metaDescription.length} max={SEO_DESCRIPTION_SOFT_MAX} />
                </div>
              </label>
              <div className="cd-field">
                <span>Preview</span>
                <div
                  style={{
                    border: "1px solid var(--hairline)",
                    borderRadius: 10,
                    padding: "10px 14px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      color: "var(--accent)",
                      fontWeight: 550,
                      fontSize: "calc(14px * var(--type-scale))",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {previewTitle}
                  </span>
                  <span
                    style={{
                      color: "var(--green)",
                      fontSize: "calc(11.5px * var(--type-scale))",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {previewUrl}
                  </span>
                  <span
                    className="cd-caption"
                    style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
                  >
                    {previewDescription}
                  </span>
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <SectionTitle>Images</SectionTitle>
            {!id && <p className="cd-caption" style={{ marginBottom: 10 }}>Save the product first, then add images.</p>}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-start" }}>
              {[...media]
                .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
                .map((m, i, ordered) => (
                <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: 4, width: 96 }}>
                  <div
                    style={{ position: "relative", width: 96, height: 96, borderRadius: 10, overflow: "hidden", background: "var(--gray-bg)" }}
                  >
                    <img src={m.url} alt={m.alt ?? ""} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
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
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <button
                      type="button"
                      className="cd-btn cd-btn-secondary cd-btn-sm"
                      aria-label="Move image earlier"
                      disabled={i === 0}
                      onClick={() => onMoveImage(m.id, "up")}
                      style={{ padding: "2px 6px" }}
                    >
                      <CDIcon name="arrowUp" size={13} strokeWidth={2} />
                    </button>
                    <button
                      type="button"
                      className="cd-btn cd-btn-secondary cd-btn-sm"
                      aria-label="Move image later"
                      disabled={i === ordered.length - 1}
                      onClick={() => onMoveImage(m.id, "down")}
                      style={{ padding: "2px 6px" }}
                    >
                      <CDIcon name="arrowDown" size={13} strokeWidth={2} />
                    </button>
                    {!m.isPrimary && (
                      <button
                        type="button"
                        className="cd-btn cd-btn-secondary cd-btn-sm"
                        onClick={() => onMakeMain(m.id)}
                        style={{ padding: "2px 6px", whiteSpace: "nowrap" }}
                      >
                        Make main
                      </button>
                    )}
                  </div>
                  <input
                    // Value-derived key: remount (and re-read defaultValue) when the
                    // saved alt changes, so a failed save's rollback is reflected.
                    key={`alt:${m.id}:${m.alt ?? ""}`}
                    className="cd-input"
                    placeholder="Alt text"
                    aria-label="Image alt text"
                    maxLength={300}
                    defaultValue={m.alt ?? ""}
                    onBlur={(e) => onSetImageAlt(m.id, e.target.value)}
                    style={{ width: 96 }}
                  />
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
                    style={{ flex: "0 1 180px", minWidth: 90 }}
                  />
                  <input
                    className="cd-input"
                    placeholder="Values, comma-separated (S, M, L)"
                    value={o.valuesText}
                    onChange={(e) => regen(options.map((x, j) => (j === i ? { ...x, valuesText: e.target.value } : x)))}
                    style={{ flex: "1 1 0", minWidth: 0 }}
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
            <div style={{ overflowX: "auto" }}>
              <div className="flex flex-col gap-2" style={{ minWidth: 780 }}>
                <div className="cd-caption" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ flex: "1 1 0", minWidth: 120 }}>Variant</span>
                  <span style={{ width: 150, flexShrink: 0 }}>SKU</span>
                  <span style={{ width: 110, flexShrink: 0, textAlign: "right" }}>Price ($)</span>
                  <span style={{ width: 110, flexShrink: 0, textAlign: "right" }}>Compare-at ($)</span>
                  <span style={{ width: 110, flexShrink: 0, textAlign: "right" }}>Cost ($)</span>
                  <span style={{ width: 64, flexShrink: 0, textAlign: "center" }}>Tracked</span>
                  {showStock && !id && <span style={{ width: 90, flexShrink: 0, textAlign: "right" }}>Stock</span>}
                </div>
                {variants.map((v, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className="cd-row-title truncate" style={{ flex: "1 1 0", minWidth: 120 }}>
                      {variantLabel(v)}
                    </span>
                    <input
                      className="cd-input"
                      placeholder="SKU"
                      aria-label={`SKU for ${variantLabel(v)}`}
                      value={v.sku ?? ""}
                      onChange={(e) => setVariantField(i, { sku: e.target.value })}
                      style={{ width: 150, flexShrink: 0 }}
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
                      style={{ width: 110, flexShrink: 0, textAlign: "right" }}
                    />
                    <input
                      className="cd-input tabular-nums"
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      aria-label={`Compare-at price for ${variantLabel(v)}`}
                      value={centsToDollars(v.compareAtPriceCents)}
                      onChange={(e) => setVariantField(i, { compareAtPriceCents: dollarsToCents(e.target.value) })}
                      style={{ width: 110, flexShrink: 0, textAlign: "right" }}
                    />
                    <input
                      className="cd-input tabular-nums"
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      aria-label={`Cost for ${variantLabel(v)}`}
                      value={centsToDollars(v.unitCostCents)}
                      onChange={(e) => setVariantField(i, { unitCostCents: dollarsToCents(e.target.value) })}
                      style={{ width: 110, flexShrink: 0, textAlign: "right" }}
                    />
                    <span style={{ width: 64, flexShrink: 0, display: "flex", justifyContent: "center" }}>
                      <input
                        type="checkbox"
                        aria-label={`Track inventory for ${variantLabel(v)}`}
                        checked={v.inventoryTracked !== false}
                        onChange={(e) => setVariantField(i, { inventoryTracked: e.target.checked })}
                      />
                    </span>
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
                        style={{ width: 90, flexShrink: 0, textAlign: "right" }}
                      />
                    )}
                  </div>
                ))}
              </div>
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
            <SectionTitle>Shipping</SectionTitle>
            <p className="cd-caption" style={{ marginBottom: 10 }}>
              Per-variant dimensions and weight are required before a variant can go live as a shippable product.
            </p>
            <div className="flex flex-col gap-4">
              {variants.map((v, i) => (
                <div key={i} className="flex flex-col gap-2" style={{ paddingBottom: i < variants.length - 1 ? 12 : 0, borderBottom: i < variants.length - 1 ? "1px solid var(--hairline)" : "none" }}>
                  <div className="cd-row-title">{variantLabel(v)}</div>
                  <label className="cd-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={v.requiresShipping !== false}
                      onChange={(e) => setVariantField(i, { requiresShipping: e.target.checked })}
                    />
                    <span>Physical product (requires shipping)</span>
                  </label>
                  {v.requiresShipping !== false && (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="cd-field">
                          <span>Weight (g)</span>
                          <input
                            className="cd-input tabular-nums"
                            type="number"
                            min="0"
                            step="1"
                            inputMode="numeric"
                            aria-label={`Weight for ${variantLabel(v)}`}
                            value={v.weightGrams ?? ""}
                            onChange={(e) =>
                              setVariantField(i, {
                                weightGrams: e.target.value === "" ? undefined : Math.max(0, Math.trunc(Number(e.target.value) || 0)),
                              })
                            }
                          />
                        </label>
                        <label className="cd-field">
                          <span>Handling days</span>
                          <input
                            className="cd-input tabular-nums"
                            type="number"
                            min="0"
                            step="1"
                            inputMode="numeric"
                            aria-label={`Handling days for ${variantLabel(v)}`}
                            value={v.handlingDays ?? ""}
                            onChange={(e) =>
                              setVariantField(i, {
                                handlingDays: e.target.value === "" ? undefined : Math.max(0, Math.trunc(Number(e.target.value) || 0)),
                              })
                            }
                          />
                        </label>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <label className="cd-field">
                          <span>Length (mm)</span>
                          <input
                            className="cd-input tabular-nums"
                            type="number"
                            min="0"
                            step="1"
                            inputMode="numeric"
                            aria-label={`Length for ${variantLabel(v)}`}
                            value={v.lengthMm ?? ""}
                            onChange={(e) =>
                              setVariantField(i, {
                                lengthMm: e.target.value === "" ? undefined : Math.max(0, Math.trunc(Number(e.target.value) || 0)),
                              })
                            }
                          />
                        </label>
                        <label className="cd-field">
                          <span>Width (mm)</span>
                          <input
                            className="cd-input tabular-nums"
                            type="number"
                            min="0"
                            step="1"
                            inputMode="numeric"
                            aria-label={`Width for ${variantLabel(v)}`}
                            value={v.widthMm ?? ""}
                            onChange={(e) =>
                              setVariantField(i, {
                                widthMm: e.target.value === "" ? undefined : Math.max(0, Math.trunc(Number(e.target.value) || 0)),
                              })
                            }
                          />
                        </label>
                        <label className="cd-field">
                          <span>Height (mm)</span>
                          <input
                            className="cd-input tabular-nums"
                            type="number"
                            min="0"
                            step="1"
                            inputMode="numeric"
                            aria-label={`Height for ${variantLabel(v)}`}
                            value={v.heightMm ?? ""}
                            onChange={(e) =>
                              setVariantField(i, {
                                heightMm: e.target.value === "" ? undefined : Math.max(0, Math.trunc(Number(e.target.value) || 0)),
                              })
                            }
                          />
                        </label>
                      </div>
                      {(() => {
                        const shippingIncomplete = !(Number(v.weightGrams) > 0 && Number(v.lengthMm) > 0 && Number(v.widthMm) > 0 && Number(v.heightMm) > 0);
                        return shippingIncomplete ? (
                          <span className="cd-caption" style={{ color: "var(--cd-warning, #b45309)" }}>Incomplete — rates estimated</span>
                        ) : null;
                      })()}
                      <label className="cd-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={v.signatureRequired === true}
                          onChange={(e) => setVariantField(i, { signatureRequired: e.target.checked })}
                        />
                        <span>Signature required on delivery</span>
                      </label>
                      <label className="cd-field">
                        <span>Restricted countries (ISO-2, comma-separated)</span>
                        <input
                          className="cd-input"
                          placeholder="e.g. RU, KP, IR"
                          aria-label={`Restricted countries for ${variantLabel(v)}`}
                          value={restrictedCountriesText(v.restrictedCountries)}
                          onChange={(e) =>
                            setVariantField(i, { restrictedCountries: parseRestrictedCountries(e.target.value) })
                          }
                        />
                      </label>
                    </>
                  )}
                </div>
              ))}
            </div>
          </Card>

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
