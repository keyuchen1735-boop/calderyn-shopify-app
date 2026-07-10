import { useEffect, useRef, useState } from "react";
import { Btn } from "../ui";
import { CDIcon } from "../icons";
import { money } from "../format";
import { fetchProducts, fetchProduct, type ProductSummaryVM, type VariantDraft } from "~/lib/dashboard/client";

/** A variant selected off the picker, shaped for the composer/edit-lines line list. */
export interface PickedVariant {
  variantId: string;
  title: string;
  unitPriceCents: number;
}

function variantLabel(product: ProductSummaryVM, variant: VariantDraft): string {
  if (variant.optionValues && variant.optionValues.length > 0) {
    return `${product.title} - ${variant.optionValues.join(" / ")}`;
  }
  return product.title;
}

/**
 * Product search -> variant add, shared by OrderComposer (Create order) and EditInvoiceLinesModal
 * (unpaid-invoice line edits). There is no variant-level search endpoint on this surface — Catalog
 * only searches at the product level (fetchProducts) — so this picker searches products, then
 * fetches ONE product's full detail (fetchProduct) on expand to read its variant ids/prices, the
 * same round trip ProductEditor already makes to populate its own variant rows.
 */
export default function VariantPicker({
  onPick,
  disabled,
}: {
  onPick: (variant: PickedVariant) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<ProductSummaryVM[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedVariants, setExpandedVariants] = useState<VariantDraft[] | null>(null);
  const [expandLoading, setExpandLoading] = useState(false);
  const expandSeq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!query) {
      setProducts(null);
      return;
    }
    let alive = true;
    setSearching(true);
    setSearchError(false);
    // Only sellable (active) products belong in an order/invoice line — a draft or archived
    // variant would pass the picker only to 422 at save/send time (variant_unavailable).
    fetchProducts({ search: query, status: "active" })
      .then((r) => {
        if (alive) setProducts(r.products);
      })
      .catch(() => {
        // A failed search must not render as "no products match" — that's an inventory claim.
        if (alive) {
          setProducts(null);
          setSearchError(true);
        }
      })
      .finally(() => {
        if (alive) setSearching(false);
      });
    return () => {
      alive = false;
    };
  }, [query]);

  const toggleExpand = async (product: ProductSummaryVM) => {
    if (expandedId === product.id) {
      setExpandedId(null);
      setExpandedVariants(null);
      return;
    }
    setExpandedId(product.id);
    setExpandedVariants(null);
    setExpandLoading(true);
    // Guard against a superseded expand resolving late: only the request for the product that is
    // STILL expanded may write its variants, or a slow Product A response would silently replace
    // the visible list under Product B's header.
    expandSeq.current += 1;
    const seq = expandSeq.current;
    try {
      const full = await fetchProduct(product.id);
      if (expandSeq.current === seq) setExpandedVariants(full.variants);
    } catch {
      if (expandSeq.current === seq) setExpandedVariants([]);
    } finally {
      if (expandSeq.current === seq) setExpandLoading(false);
    }
  };

  const pickVariant = (product: ProductSummaryVM, variant: VariantDraft) => {
    if (!variant.id) return;
    onPick({
      variantId: variant.id,
      title: variantLabel(product, variant),
      unitPriceCents: variant.retailPriceCents ?? 0,
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="flex items-center" style={{ gap: 8 }}>
        <CDIcon name="search" size={15} style={{ color: "var(--text-3)", flexShrink: 0 }} />
        <input
          className="cd-input"
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search products to add"
          aria-label="Search products to add"
          disabled={disabled}
          style={{ flex: 1 }}
        />
      </div>
      {query && (
        <div
          style={{
            border: "1px solid var(--hairline)",
            borderRadius: 10,
            maxHeight: 260,
            overflowY: "auto",
          }}
        >
          {searching ? (
            <div className="cd-caption" style={{ padding: 12 }}>Searching…</div>
          ) : searchError ? (
            <div className="cd-caption" style={{ padding: 12 }}>Search failed just now. Type to retry.</div>
          ) : !products || products.length === 0 ? (
            <div className="cd-caption" style={{ padding: 12 }}>No products match "{query}".</div>
          ) : (
            products.map((p) => (
              <div key={p.id} style={{ borderBottom: "1px solid var(--hairline)" }}>
                <button
                  type="button"
                  onClick={() => toggleExpand(p)}
                  disabled={disabled}
                  className="flex items-center justify-between"
                  style={{
                    width: "100%",
                    background: "none",
                    border: 0,
                    padding: "10px 12px",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div className="cd-row-title truncate">{p.title}</div>
                    <div className="cd-caption">
                      {p.variantCount} variant{p.variantCount === 1 ? "" : "s"}
                      {p.priceCents != null ? ` · from ${money(p.priceCents)}` : ""}
                    </div>
                  </div>
                  <CDIcon
                    name={expandedId === p.id ? "chevronUp" : "chevronDown"}
                    size={14}
                    style={{ color: "var(--text-3)", flexShrink: 0 }}
                  />
                </button>
                {expandedId === p.id && (
                  <div style={{ padding: "0 12px 10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                    {expandLoading ? (
                      <div className="cd-caption">Loading variants…</div>
                    ) : !expandedVariants || expandedVariants.length === 0 ? (
                      <div className="cd-caption">No sellable variants on this product.</div>
                    ) : (
                      expandedVariants.map((v, i) => (
                        <div
                          key={v.id ?? i}
                          className="flex items-center justify-between"
                          style={{ gap: 8 }}
                        >
                          <div className="cd-caption truncate">
                            {v.optionValues && v.optionValues.length > 0 ? v.optionValues.join(" / ") : p.title}
                            {v.sku ? ` · ${v.sku}` : ""}
                            {v.retailPriceCents != null ? ` · ${money(v.retailPriceCents)}` : ""}
                          </div>
                          <Btn
                            small
                            icon="plus"
                            disabled={disabled || !v.id}
                            onClick={() => pickVariant(p, v)}
                          >
                            Add
                          </Btn>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
