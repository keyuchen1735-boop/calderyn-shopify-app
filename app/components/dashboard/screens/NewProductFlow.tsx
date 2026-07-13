// New-product flow: prompt-first, step-confirmed. Describe the product once
// and a draft lands; walk Basics → Details → Preview confirming (or
// re-prompting) as you go; the last step previews the buyer's listing page and
// the store-grid tile before the real save.
//
// Prompt handling is deterministic-first: known intents parse locally
// (app/lib/catalog/listing-prompt.ts, instant and free); fresh drafts and
// unrecognized edits go to the Claude-backed /dashboard/api/listing-draft.
// A failed AI call degrades honestly — deterministic fallback for fresh
// drafts, an error toast for edits. Saving writes the owned catalog through
// the same saveProduct contract as the editor; photos upload right after the
// first save (media rows need a product id).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import type { DashboardCtx } from "../context";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import { buildVariantMatrix } from "~/lib/catalog/variant-matrix";
import { dollarsToCents, nonNegInt, parseOptionRows, posInt } from "~/lib/catalog/product-form";
import { storefrontListingUrl } from "~/lib/storefront/listing-url";
import {
  draftPlanFromPrompt,
  parseListingPrompt,
  type ListingOp,
  type ListingPlan,
} from "~/lib/catalog/listing-prompt";
import { reduced } from "../hero/hero-motion";
import { addPhotos, summarizePhotoRejections, type PhotoDraft } from "./new-product-photos";
import { variantSummary } from "./new-product-copy";
import { Card, Btn, SectionTitle, Segmented } from "../ui";
import { CDIcon } from "../icons";

type OptRow = { name: string; values: string };
type Cell = { price: string; stock: string };

function mergeCell(cells: Record<string, Cell>, label: string, patch: Partial<Cell>): Record<string, Cell> {
  const prev = cells[label] ?? { price: "", stock: "" };
  return { ...cells, [label]: { ...prev, ...patch } };
}

const MAX_PHOTOS = 8; // per-pick cap; type/size rules live in new-product-photos.ts

const PROMPT_MAX = 300; // matches the endpoint's invalid_prompt bound

const MAX_OPTIONS = 3; // matches the catalog write path's too_many_options bound

// Friendly copy for the write path's 422 codes (the server sends bare codes).
const SAVE_ERRORS: Record<string, { message: string; step: StepId }> = {
  incomplete_shipping: { message: "Add size and weight before this product can go live.", step: "details" },
  too_many_options: { message: "A product can have at most 3 options.", step: "details" },
  too_many_variants: { message: "That's too many variant combinations — trim some option values.", step: "details" },
};

type StepId = "describe" | "basics" | "details" | "preview";
const STEP_ORDER: { id: StepId; label: string }[] = [
  { id: "describe", label: "Describe" },
  { id: "basics", label: "Basics" },
  { id: "details", label: "Details" },
  { id: "preview", label: "Preview" },
];
// Which step shows the field a glow-key belongs to — edit prompts jump there
// so the change is watchable.
const STEP_OF_FIELD: Record<string, StepId> = {
  title: "basics",
  price: "basics",
  stock: "basics",
  desc: "basics",
  options: "details",
  shipping: "details",
  tags: "details",
  status: "preview",
};

// Known ops → the field to glow. Doubles as the client's forward-compat
// filter: an op kind this bundle doesn't know is dropped loudly, never
// silently no-op'd while the receipt claims success.
const GLOW_OF_OP: Record<ListingOp["op"], string> = {
  set_title: "title",
  set_price: "price",
  scale_price: "price",
  set_stock: "stock",
  set_description: "desc",
  set_tags: "tags",
  add_option: "options",
  set_shipping: "shipping",
  set_status: "status",
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="cd-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function OptionRows({ opts, onChange }: { opts: OptRow[]; onChange: (next: OptRow[]) => void }) {
  return (
    <div className="flex flex-col gap-2">
      {opts.map((o, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            className="cd-input"
            placeholder="Option (e.g. Size)"
            value={o.name}
            onChange={(e) => onChange(opts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            style={{ flex: "0 1 150px", minWidth: 84 }}
          />
          <input
            className="cd-input"
            placeholder="Values, comma-separated (S, M, L)"
            value={o.values}
            onChange={(e) => onChange(opts.map((x, j) => (j === i ? { ...x, values: e.target.value } : x)))}
            style={{ flex: "1 1 0", minWidth: 0 }}
          />
          <button
            type="button"
            aria-label="Remove option"
            onClick={() => onChange(opts.filter((_, j) => j !== i))}
            style={{ border: 0, background: "transparent", color: "var(--text-3)", cursor: "pointer", padding: 4 }}
          >
            <CDIcon name="x" size={15} />
          </button>
        </div>
      ))}
      {opts.length < MAX_OPTIONS && (
        <div>
          <Btn small icon="plus" onClick={() => onChange([...opts, { name: "", values: "" }])}>
            Add option
          </Btn>
        </div>
      )}
    </div>
  );
}

function ComboTable({
  combos,
  cells,
  onCell,
  basePlaceholder,
}: {
  combos: string[];
  cells: Record<string, Cell>;
  onCell: (label: string, patch: Partial<Cell>) => void;
  basePlaceholder?: string;
}) {
  if (!combos.length) return null;
  return (
    <div className="flex flex-col gap-2" style={{ marginTop: 10 }}>
      <div className="cd-caption" style={{ display: "flex", gap: 8 }}>
        <span style={{ flex: "1 1 0" }}>Variant</span>
        <span style={{ width: 96, textAlign: "right" }}>Price ($)</span>
        <span style={{ width: 76, textAlign: "right" }}>Stock</span>
      </div>
      {combos.map((label) => (
        <div key={label} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="cd-row-title truncate" style={{ flex: "1 1 0", minWidth: 60 }}>
            {label}
          </span>
          <input
            className="cd-input tabular-nums"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            placeholder={basePlaceholder || "0.00"}
            aria-label={`Price for ${label}`}
            value={cells[label]?.price ?? ""}
            onChange={(e) => onCell(label, { price: e.target.value })}
            style={{ width: 96, textAlign: "right" }}
          />
          <input
            className="cd-input tabular-nums"
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            placeholder="0"
            aria-label={`Stock for ${label}`}
            value={cells[label]?.stock ?? ""}
            onChange={(e) => onCell(label, { stock: e.target.value })}
            style={{ width: 76, textAlign: "right" }}
          />
        </div>
      ))}
    </div>
  );
}

function CollectionChips({
  collections,
  selected,
  error,
  onToggle,
}: {
  collections: client.CollectionVM[];
  selected: string[];
  error?: boolean;
  onToggle: (id: string) => void;
}) {
  if (error) {
    return (
      <p className="cd-caption">
        Couldn&apos;t load collections — you can add this product to collections later from the
        editor.
      </p>
    );
  }
  if (!collections.length) {
    return <p className="cd-caption">No collections yet — create one on the Collections screen.</p>;
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {collections.map((c) => {
        const on = selected.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            className="cd-badge"
            onClick={() => onToggle(c.id)}
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
  );
}

export default function NewProductFlow({ app }: { app: DashboardCtx }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const timers = useRef<number[]>([]);
  const aliveRef = useRef(true);

  const [step, setStep] = useState<StepId>("describe");
  // Latest step for callbacks that outlive a render (staged prompt applies).
  const stepRef = useRef<StepId>("describe");
  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  const [previewView, setPreviewView] = useState<"page" | "grid">("page");
  const [prompt, setPrompt] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [photos, setPhotos] = useState<PhotoDraft[]>([]);
  const [receipts, setReceipts] = useState<{ id: string; text: string }[]>([]);
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [stock, setStock] = useState("");
  const [desc, setDesc] = useState("");
  const [opts, setOpts] = useState<OptRow[]>([]);
  const [cells, setCells] = useState<Record<string, Cell>>({});
  const [combosOpen, setCombosOpen] = useState(false);
  const [physical, setPhysical] = useState(true);
  const [weight, setWeight] = useState("");
  const [dims, setDims] = useState({ l: "", w: "", h: "" });
  const [status, setStatus] = useState<"draft" | "active">("draft");
  const [vendor, setVendor] = useState("");
  const [tags, setTags] = useState("");
  const [collections, setCollections] = useState<client.CollectionVM[]>([]);
  const [collectionsError, setCollectionsError] = useState(false);
  const [sel, setSel] = useState<string[]>([]);

  useEffect(() => {
    client.fetchCollections().then(setCollections).catch(() => setCollectionsError(true));
  }, []);

  // Pending prompt-apply steps die with the component (the timers array keeps
  // one identity for its whole life — cleared in place, never reassigned).
  // aliveRef is re-armed in the effect BODY: cleanup also runs on dev hot
  // updates, and a ref's initial value does not re-apply on re-render.
  useEffect(() => {
    aliveRef.current = true;
    const t = timers;
    return () => {
      aliveRef.current = false;
      t.current.forEach((id) => window.clearTimeout(id));
    };
  }, []);

  // Each picked photo gets one object URL, revoked when its tile is removed
  // or on unmount (the ref keeps the latest list visible to the cleanup).
  const photosRef = useRef<PhotoDraft[]>(photos);
  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);
  useEffect(() => {
    return () => {
      photosRef.current.forEach((p) => URL.revokeObjectURL(p.url));
    };
  }, []);

  // Choreography: shimmer + pulsing spark while a prompt is working; step and
  // preview panels rise in. revertOnUpdate kills the repeating tweens the
  // moment the phase moves on.
  const { contextSafe } = useGSAP(
    () => {
      if (reduced()) return;
      if (drafting) {
        gsap.to(".npf-shimmer", { xPercent: 420, duration: 1.15, ease: "power1.inOut", repeat: -1 });
        gsap.to(".npf-spark", { scale: 1.16, opacity: 0.7, duration: 0.55, ease: "power1.inOut", yoyo: true, repeat: -1 });
      }
    },
    { dependencies: [drafting], scope: rootRef, revertOnUpdate: true },
  );

  useGSAP(
    () => {
      if (reduced()) return;
      gsap.from(".npf-step", { opacity: 0, y: 12, duration: 0.32, ease: "power3.out", clearProps: "opacity,transform" });
    },
    { dependencies: [step], scope: rootRef },
  );

  useGSAP(
    () => {
      if (reduced() || step !== "preview") return;
      gsap.from(".npf-pv", { opacity: 0, y: 8, duration: 0.3, ease: "power2.out", clearProps: "opacity,transform" });
      gsap.from(".npf-pv-el", { opacity: 0, y: 8, duration: 0.32, ease: "power2.out", stagger: 0.05, clearProps: "opacity,transform" });
    },
    { dependencies: [previewView, step], scope: rootRef },
  );

  const glow = contextSafe((key: string) => {
    if (reduced()) return;
    const el = rootRef.current?.querySelector(`[data-f="${key}"]`);
    if (el) {
      gsap.fromTo(
        el,
        { backgroundColor: "rgba(79,109,245,0.18)" },
        { backgroundColor: "rgba(79,109,245,0)", duration: 0.9, ease: "power2.out", clearProps: "backgroundColor" },
      );
    }
  });

  const onPickPhotos = (list: FileList) => {
    const { next, rejected } = addPhotos(photos, Array.from(list), MAX_PHOTOS, (f) => URL.createObjectURL(f));
    setPhotos(next);
    const summary = summarizePhotoRejections(rejected);
    if (summary) app.toast(summary, "warn");
  };

  const removePhoto = (i: number) => {
    const target = photos[i];
    if (!target) return;
    URL.revokeObjectURL(target.url);
    setPhotos((cur) => cur.filter((p) => p !== target));
  };

  const addOption = (name: string, values: string[]) => {
    setOpts((cur) => {
      const row = { name, values: values.join(", ") };
      const i = cur.findIndex((o) => o.name.trim().toLowerCase() === name.toLowerCase());
      if (i >= 0) return cur.map((o, j) => (j === i ? row : o));
      if (cur.length >= MAX_OPTIONS) {
        app.toast(`Products support up to ${MAX_OPTIONS} options.`, "warn");
        return cur;
      }
      return [...cur, row];
    });
  };

  // Derived once per options change; labels come from the SAME matrix builder
  // the save path uses, so the per-combo cells always key-match at save time.
  const parsedOpts = useMemo(() => parseOptionRows(opts), [opts]);
  const combos = useMemo(
    () =>
      parsedOpts.length
        ? buildVariantMatrix(parsedOpts, []).map((v) => (v.optionValues ?? []).join(" / "))
        : [],
    [parsedOpts],
  );

  // One op → one state update. Returns the glow key so the apply loop can
  // highlight what changed.
  const applyOp = (op: ListingOp): string => {
    switch (op.op) {
      case "set_title":
        setTitle(op.title);
        break;
      case "set_price": {
        setPrice((op.priceCents / 100).toFixed(2));
        // Per-combo prices override the base at save, so a prompt-set price
        // clears them — otherwise the confirmed change never reaches the store.
        setCells((cur) =>
          Object.fromEntries(Object.entries(cur).map(([k, c]) => [k, { ...c, price: "" }])),
        );
        break;
      }
      case "scale_price": {
        const factor = op.factor;
        setPrice((cur) => {
          const n = Number(cur);
          return n > 0 ? (n * factor).toFixed(2) : cur;
        });
        setCells((cur) =>
          Object.fromEntries(
            Object.entries(cur).map(([k, c]) => [
              k,
              Number(c.price) > 0 ? { ...c, price: (Number(c.price) * factor).toFixed(2) } : c,
            ]),
          ),
        );
        break;
      }
      case "set_stock":
        setStock(String(op.stock));
        // Per-combo stock overrides the base at save, so a prompt-set stock clears
        // them — otherwise the confirmed change never reaches a variant that
        // already has a stock cell (mirrors set_price).
        setCells((cur) =>
          Object.fromEntries(Object.entries(cur).map(([k, c]) => [k, { ...c, stock: "" }])),
        );
        break;
      case "set_description":
        setDesc(op.description);
        break;
      case "set_tags":
        setTags(op.tags.join(", "));
        break;
      case "add_option":
        addOption(op.name, op.values);
        break;
      case "set_shipping":
        setPhysical(true);
        setWeight(String(op.weightGrams));
        setDims({ l: String(op.lengthMm), w: String(op.widthMm), h: String(op.heightMm) });
        break;
      case "set_status":
        setStatus(op.status);
        break;
    }
    return GLOW_OF_OP[op.op];
  };

  // Stage a plan into the form: fresh drafts land in one beat behind the
  // describe-hero shimmer (clamped by however long the network already took);
  // edits jump to the step they touch and glow in one by one.
  const applyPlanStaged = (plan: ListingPlan, o: { fresh: boolean; elapsedMs?: number }) => {
    const ops = plan.ops.filter((op) => op.op in GLOW_OF_OP);
    if (!ops.length) {
      setDrafting(false);
      app.toast("That change isn't supported here yet — try rephrasing.", "warn");
      return;
    }
    timers.current.splice(0).forEach((id) => window.clearTimeout(id));
    const at = (ms: number, fn: () => void) =>
      timers.current.push(
        window.setTimeout(() => {
          if (aliveRef.current) fn();
        }, ms),
      );
    setDrafting(true);

    let t = 0;
    if (o.fresh) {
      t = Math.max(250, 1200 - (o.elapsedMs ?? 0));
      at(t, () => ops.forEach(applyOp));
    } else {
      const target = STEP_OF_FIELD[GLOW_OF_OP[ops[0].op]];
      if (stepRef.current !== "preview" && target && target !== stepRef.current) setStep(target);
      for (const op of ops) {
        t += 480;
        at(t, () => glow(applyOp(op)));
      }
    }

    t += 620;
    at(t, () => {
      setDrafting(false);
      if (o.fresh) setStep("basics");
      setReceipts((r) => [
        ...r,
        ...plan.summaries.map((text, i) => ({ id: `${r.length}-${i}-${text}`, text })),
      ]);
      const last = plan.summaries[plan.summaries.length - 1] ?? "Applied your change";
      app.toast(`${last} — updated.`, "sparkle");
    });
  };

  // Shipping completeness, computed once from the SAME integer parses the save
  // path sends (a fractional "0.5" must not read as complete here and 0 there).
  const shipInts = {
    weightGrams: posInt(weight),
    lengthMm: posInt(dims.l),
    widthMm: posInt(dims.w),
    heightMm: posInt(dims.h),
  };
  const shippingDone =
    shipInts.weightGrams !== undefined &&
    shipInts.lengthMm !== undefined &&
    shipInts.widthMm !== undefined &&
    shipInts.heightMm !== undefined;

  const currentListing = (): client.ListingDraftCurrent => ({
    title: title.trim(),
    price_cents: dollarsToCents(price) ?? null,
    stock: nonNegInt(stock) ?? null,
    description: desc.trim(),
    tags: tags.split(",").map((s) => s.trim()).filter(Boolean),
    options: parsedOpts,
    status,
    has_shipping: !physical || shippingDone,
  });

  const runPrompt = async () => {
    const p = prompt.trim();
    if (!p) {
      app.toast("Type what you want — one sentence is plenty.", "warn");
      return;
    }
    if (drafting || saving) return;

    // "Fresh" = nothing worth preserving yet. A merchant mid-manual-entry must
    // never have their form clobbered by a draft — this includes stock and tags
    // (set behind "Shipping & extras"), not just title/price/description/options.
    const fresh =
      !title.trim() && !price.trim() && !desc.trim() && opts.length === 0 && !stock.trim() && !tags.trim();
    if (!fresh) {
      // Known intents apply instantly and free of API spend.
      const local = parseListingPrompt(p, {
        title,
        priceCents: dollarsToCents(price) ?? null,
        hasShipping: physical && shippingDone,
      });
      if (local.ops.length) {
        setPrompt("");
        applyPlanStaged(local, { fresh: false });
        return;
      }
    }

    // Fresh drafts and unrecognized edits go to the AI endpoint. The shimmer
    // runs through the network wait.
    setPrompt("");
    setDrafting(true);
    const t0 = performance.now();
    try {
      const plan = await client.fetchListingDraft(p, currentListing());
      if (!aliveRef.current) return;
      applyPlanStaged(plan, { fresh, elapsedMs: performance.now() - t0 });
    } catch (err) {
      if (!aliveRef.current) return;
      const code = err instanceof DashboardApiError ? err.code : null;
      if (
        code === "invalid_prompt" ||
        code === "rate_limited" ||
        code === "ai_cooldown" ||
        code === "ai_daily_limit"
      ) {
        // User-actionable — surface the server's guidance, don't fall back.
        setDrafting(false);
        app.toast(err instanceof DashboardApiError ? err.message : "Try a shorter prompt.", "warn");
      } else if (fresh) {
        // The flow still works without the AI: honest notice + basic defaults.
        app.toast("AI drafting is unavailable — used quick defaults you can edit.", "warn");
        applyPlanStaged(draftPlanFromPrompt(p), { fresh: true });
      } else {
        setDrafting(false);
        app.toast(
          err instanceof DashboardApiError ? err.message : "Couldn't apply that change.",
          "warn",
          "critical",
        );
      }
    }
  };

  const onSave = async () => {
    if (saving || drafting) return;
    if (!title.trim()) {
      app.toast("Add a product title.", "warn");
      setStep("basics");
      return;
    }
    const baseCents = dollarsToCents(price);
    const matrix = buildVariantMatrix(parsedOpts, []);
    // Effective per-variant price = its cell price, else the base price. An active
    // product must have EVERY variant priced above $0 — otherwise the ones that
    // fall through to a blank base are saved unpriced and are silently unbuyable
    // on the storefront (the merchant thinks the whole product is on sale).
    if (status === "active") {
      const unpriced = matrix.some((v) => {
        const label = (v.optionValues ?? []).join(" / ");
        const eff = dollarsToCents(cells[label]?.price ?? "") ?? baseCents;
        return eff === undefined || eff <= 0;
      });
      if (unpriced) {
        app.toast("Give every variant a price before putting it on sale.", "warn");
        setStep("basics");
        return;
      }
    }
    setSaving(true);
    try {
      const baseStock = nonNegInt(stock);
      // Each shipping field persists independently (a weight without box dims
      // still saves); completeness is only a go-live requirement.
      const ship = physical
        ? {
            ...(shipInts.weightGrams !== undefined ? { weightGrams: shipInts.weightGrams } : {}),
            ...(shipInts.lengthMm !== undefined ? { lengthMm: shipInts.lengthMm } : {}),
            ...(shipInts.widthMm !== undefined ? { widthMm: shipInts.widthMm } : {}),
            ...(shipInts.heightMm !== undefined ? { heightMm: shipInts.heightMm } : {}),
          }
        : {};
      const variants = matrix.map((v) => {
        const label = (v.optionValues ?? []).join(" / ");
        const cell = cells[label];
        return {
          ...v,
          retailPriceCents: dollarsToCents(cell?.price ?? "") ?? baseCents,
          inventoryOnHand: nonNegInt(cell?.stock ?? "") ?? baseStock,
          requiresShipping: physical,
          ...ship,
        };
      });
      const draft: client.ProductDraft = {
        title: title.trim(),
        status,
        vendor: vendor.trim() || undefined,
        description: desc.trim() || undefined,
        tags: tags.split(",").map((s) => s.trim()).filter(Boolean),
        options: parsedOpts,
        variants,
        collectionIds: sel,
      };
      const { id } = await client.saveProduct(draft);
      if (photos.length > 0) {
        // Sequential and in tile order: the first successful upload becomes
        // the primary image server-side, so order is meaningful.
        let failed = 0;
        let mainFailed = false;
        for (const [i, p] of photos.entries()) {
          try {
            await client.uploadProductImage(id, p.file);
          } catch {
            failed += 1;
            // Losing tile 0 silently promotes the next photo to the
            // storefront lead image — that needs its own callout.
            if (i === 0) mainFailed = true;
          }
        }
        if (mainFailed) {
          app.toast(
            "Saved, but your main photo didn't upload — the storefront is using the next photo. Fix it from the product editor.",
            "warn",
            "critical",
          );
        } else if (failed > 0) {
          app.toast(`Saved, but ${failed} photo(s) didn't upload — add them from the product editor.`, "warn", "critical");
        }
      }
      app.toast(status === "active" ? "Product saved — live in your store." : "Product saved as a draft.", "check");
      app.navigate("product-editor", id);
    } catch (err) {
      const known = err instanceof DashboardApiError ? SAVE_ERRORS[err.code] : undefined;
      if (known) {
        app.toast(known.message, "warn", "critical");
        setStep(known.step);
      } else {
        app.toast(err instanceof DashboardApiError ? err.message : "Couldn't save the product.", "warn", "critical");
      }
    } finally {
      setSaving(false);
    }
  };

  const sizeOpt = opts.find((o) => o.name.trim().toLowerCase() === "size");
  const sizeValues = sizeOpt ? sizeOpt.values.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const priceText = Number(price) > 0 ? `$${Number(price).toFixed(2)}` : "$0.00";
  const stepIdx = STEP_ORDER.findIndex((s) => s.id === step);
  // The tenant's real storefront listing URL — real org_slug + /storefront path,
  // so the previewed link resolves to the live store (not a re-derived slug).
  const listingUrl = storefrontListingUrl(app.orgSlug, app.storeLabel, title);

  const readiness = [
    { label: "Title", done: Boolean(title.trim()) },
    { label: "Price", done: Number(price) > 0 || Object.values(cells).some((c) => Number(c.price) > 0) },
    { label: "Photo", done: photos.length > 0 },
    { label: "Shipping", done: !physical || shippingDone },
  ];

  const shimmerBar = (
    <span
      className="npf-shimmer"
      aria-hidden="true"
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: "-30%",
        width: "26%",
        transform: "skewX(-14deg)",
        background: "linear-gradient(90deg, transparent, color-mix(in oklch, var(--accent) 22%, transparent), transparent)",
      }}
    />
  );

  const sparkBadge = (size: number) => (
    <span
      className="npf-spark"
      style={{
        display: "flex",
        width: size,
        height: size,
        borderRadius: 999,
        alignItems: "center",
        justifyContent: "center",
        background: "var(--accent-bg)",
        color: "var(--accent)",
        flex: "0 0 auto",
      }}
    >
      <CDIcon name="sparkle" size={Math.round(size * 0.48)} />
    </span>
  );

  const photoRow =
    photos.length > 0 ? (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {photos.map((p, i) => (
          <div
            key={p.url}
            style={{ position: "relative", width: 72, height: 72, borderRadius: 10, overflow: "hidden", background: "var(--gray-bg)" }}
          >
            <img src={p.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            {i === 0 && (
              <span
                className="cd-badge"
                style={{
                  position: "absolute",
                  left: 4,
                  bottom: 4,
                  padding: "1px 6px",
                  background: "color-mix(in oklch, var(--card) 88%, transparent)",
                  color: "var(--text-2)",
                }}
              >
                Main
              </span>
            )}
            <button
              type="button"
              aria-label={`Remove photo ${i + 1}`}
              onClick={() => removePhoto(i)}
              style={{
                position: "absolute",
                top: 4,
                right: 4,
                width: 20,
                height: 20,
                padding: 0,
                borderRadius: 999,
                border: 0,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "color-mix(in oklch, var(--card) 82%, transparent)",
                color: "var(--text-2)",
              }}
            >
              <CDIcon name="x" size={12} strokeWidth={2.2} />
            </button>
          </div>
        ))}
      </div>
    ) : null;

  const stepNav = (nextLabel: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
      <Btn disabled={drafting} onClick={() => setStep(STEP_ORDER[Math.max(0, stepIdx - 1)].id)}>
        Back
      </Btn>
      <Btn
        kind="primary"
        icon="arrowRight"
        disabled={drafting}
        onClick={() => {
          if (step === "basics" && !title.trim()) {
            app.toast("Add a title first.", "warn");
            return;
          }
          setStep(STEP_ORDER[Math.min(STEP_ORDER.length - 1, stepIdx + 1)].id);
        }}
      >
        {nextLabel}
      </Btn>
    </div>
  );

  return (
    <div className="cd-screen" data-screen-label="Product editor" ref={rootRef}>
      <button className="cd-back" onClick={() => app.navigate("catalog")}>
        <CDIcon name="chevronLeft" size={15} />
        Products
      </button>
      <header className="cd-screen-head" style={{ marginTop: 4 }}>
        <div>
          <h1 className="cd-h1">New product</h1>
        </div>
      </header>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onPickPhotos(e.target.files);
          e.target.value = "";
        }}
      />

      <div style={{ maxWidth: 720, width: "100%", margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Step rail */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 2px" }}>
          {STEP_ORDER.map((s, i) => {
            const done = i < stepIdx || (s.id === "describe" && Boolean(title.trim()));
            const active = s.id === step;
            return (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, flex: i < STEP_ORDER.length - 1 ? "1 1 0" : "0 0 auto" }}>
                <button
                  type="button"
                  aria-label={s.label}
                  onClick={() => i < stepIdx && setStep(s.id)}
                  style={{ display: "flex", alignItems: "center", gap: 7, border: 0, background: "transparent", cursor: i < stepIdx ? "pointer" : "default", padding: 0 }}
                >
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 24,
                      height: 24,
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 650,
                      background: done ? "var(--green-bg)" : active ? "var(--accent)" : "var(--gray-bg)",
                      color: done ? "var(--green)" : active ? "var(--on-accent)" : "var(--text-3)",
                      flex: "0 0 auto",
                    }}
                  >
                    {done ? <CDIcon name="check" size={13} strokeWidth={2.4} /> : i + 1}
                  </span>
                  <span className="cd-row-title npf-step-lab" data-active={active ? "1" : "0"}>
                    {s.label}
                  </span>
                </button>
                {i < STEP_ORDER.length - 1 && (
                  <span style={{ flex: "1 1 0", height: 2, borderRadius: 2, background: i < stepIdx ? "var(--green)" : "var(--hairline-strong)", opacity: i < stepIdx ? 0.5 : 1 }} />
                )}
              </div>
            );
          })}
        </div>

        {/* Prompt bar (the describe step's hero IS the composer) */}
        {step !== "describe" && (
          <div
            style={{
              position: "relative",
              overflow: "hidden",
              display: "flex",
              gap: 8,
              alignItems: "center",
              padding: "8px 10px",
              borderRadius: 12,
              border: "1px solid var(--hairline-strong)",
              background: "var(--card)",
            }}
          >
            {sparkBadge(28)}
            <input
              className="cd-input"
              style={{ flex: "1 1 180px", minWidth: 0, border: 0, background: "transparent", padding: "6px 4px" }}
              placeholder='Tell it what to change — "make it have a bunch of sizes"'
              maxLength={PROMPT_MAX}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") runPrompt();
              }}
              disabled={drafting}
              aria-label="Prompt"
            />
            <Btn small icon="image" onClick={() => fileRef.current?.click()}>
              {photos.length > 0 ? "Add more" : "Photos"}
            </Btn>
            <Btn small kind="primary" icon="sparkle" disabled={drafting} onClick={runPrompt}>
              {drafting ? "Working…" : "Apply"}
            </Btn>
            {drafting && shimmerBar}
          </div>
        )}
        {step !== "describe" && receipts.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: -6 }}>
            {receipts.slice(-4).map((r) => (
              <span key={r.id} className="cd-badge" style={{ background: "var(--green-bg)", color: "var(--green)" }}>
                <CDIcon name="check" size={12} strokeWidth={2} />
                {r.text}
              </span>
            ))}
          </div>
        )}
        {step !== "describe" && photoRow}

        {/* ---- Step: Describe ---- */}
        {step === "describe" && (
          <Card className="npf-step">
            <div style={{ position: "relative", overflow: "hidden", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 12, padding: "26px 8px" }}>
              {sparkBadge(46)}
              {drafting ? (
                <>
                  <div className="cd-h2">Drafting your listing…</div>
                  <p className="cd-caption">Title, price, stock, description — you confirm each step next.</p>
                  {shimmerBar}
                </>
              ) : (
                <>
                  <div className="cd-h2">What are you selling?</div>
                  <div style={{ display: "flex", gap: 8, width: "100%", maxWidth: 520 }}>
                    <input
                      className="cd-input"
                      style={{ flex: "1 1 0", minWidth: 0 }}
                      placeholder='"t shirt for my brand"'
                      maxLength={PROMPT_MAX}
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") runPrompt();
                      }}
                      aria-label="Prompt"
                    />
                    <Btn kind="primary" icon="sparkle" onClick={runPrompt}>
                      Draft it
                    </Btn>
                  </div>
                  <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                    <button type="button" className="cd-link" onClick={() => fileRef.current?.click()}>
                      {photos.length > 0 ? "Add more" : "Add photos"}
                    </button>
                    <button type="button" className="cd-link" onClick={() => setStep("basics")}>
                      Start blank instead
                    </button>
                  </div>
                  {photoRow}
                </>
              )}
            </div>
          </Card>
        )}

        {/* ---- Step: Basics ---- */}
        {step === "basics" && (
          <Card className="npf-step">
            <div className="flex flex-col gap-3">
              <Field label="Title">
                <input className="cd-input" data-f="title" placeholder="What are you selling?" value={title} onChange={(e) => setTitle(e.target.value)} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Price ($)">
                  <input
                    className="cd-input tabular-nums"
                    data-f="price"
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                  />
                </Field>
                <Field label="In stock">
                  <input
                    className="cd-input tabular-nums"
                    data-f="stock"
                    type="number"
                    min="0"
                    step="1"
                    inputMode="numeric"
                    placeholder="0"
                    value={stock}
                    onChange={(e) => setStock(e.target.value)}
                  />
                </Field>
              </div>
              <Field label="Description">
                <textarea className="cd-input" data-f="desc" rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} />
              </Field>
              {stepNav("Looks good")}
            </div>
          </Card>
        )}

        {/* ---- Step: Details ---- */}
        {step === "details" && (
          <Card className="npf-step">
            <div className="flex flex-col gap-4">
              <div data-f="options" style={{ borderRadius: 10, margin: -6, padding: 6 }}>
                <SectionTitle>Sizes & colors</SectionTitle>
                {opts.length === 0 ? (
                  <div style={{ display: "flex", gap: 8 }}>
                    <Btn small icon="plus" onClick={() => addOption("Size", ["S", "M", "L"])}>
                      Sizes
                    </Btn>
                    <Btn small icon="plus" onClick={() => addOption("Color", ["Black", "White"])}>
                      Colors
                    </Btn>
                  </div>
                ) : (
                  <>
                    <OptionRows opts={opts} onChange={setOpts} />
                    {combos.length > 0 && !combosOpen && (
                      <button type="button" className="cd-npf-combo-summary" onClick={() => setCombosOpen(true)}>
                        {variantSummary(combos.length, price)}
                        <span className="cd-npf-combo-edit">Edit each</span>
                      </button>
                    )}
                    {combos.length > 0 && combosOpen && (
                      <>
                        <ComboTable
                          combos={combos}
                          cells={cells}
                          onCell={(label, patch) => setCells((c) => mergeCell(c, label, patch))}
                          basePlaceholder={price || undefined}
                        />
                        <button type="button" className="cd-npf-combo-summary" onClick={() => setCombosOpen(false)}>
                          Done
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>

              <div style={{ height: 1, background: "var(--hairline)" }} />

              <div data-f="shipping" style={{ borderRadius: 10, margin: -6, padding: 6 }}>
                <SectionTitle>Shipping</SectionTitle>
                <div className="flex flex-col gap-3">
                  <div className="cd-npf-shipq">
                    <span className="cd-npf-shipq-l">Does this ship in a box?</span>
                    <div className="cd-npf-shipq-btns">
                      <Btn small kind={physical ? "primary" : undefined} onClick={() => setPhysical(true)}>
                        Yes
                      </Btn>
                      <Btn small kind={!physical ? "primary" : undefined} onClick={() => setPhysical(false)}>
                        No
                      </Btn>
                    </div>
                  </div>
                  {physical ? (
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Weight (grams)">
                        <input className="cd-input tabular-nums" type="number" min="0" inputMode="numeric" value={weight} onChange={(e) => setWeight(e.target.value)} />
                      </Field>
                      <Field label="Box size (L × W × H, mm)">
                        <div style={{ display: "flex", gap: 6 }}>
                          {(["l", "w", "h"] as const).map((k) => (
                            <input
                              key={k}
                              className="cd-input tabular-nums"
                              type="number"
                              min="0"
                              inputMode="numeric"
                              placeholder={k.toUpperCase()}
                              aria-label={`Box ${k === "l" ? "length" : k === "w" ? "width" : "height"} (mm)`}
                              value={dims[k]}
                              onChange={(e) => setDims((d) => ({ ...d, [k]: e.target.value }))}
                              style={{ flex: "1 1 0", minWidth: 0 }}
                            />
                          ))}
                        </div>
                      </Field>
                    </div>
                  ) : (
                    <p className="cd-caption">No shipping needed — digital, service, or pickup-only.</p>
                  )}
                </div>
              </div>

              <div style={{ height: 1, background: "var(--hairline)" }} />

              <div>
                <SectionTitle>Organize</SectionTitle>
                <p className="cd-caption">Optional — helps group products later. Fine to skip.</p>
                <div className="flex flex-col gap-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Vendor">
                      <input className="cd-input" value={vendor} onChange={(e) => setVendor(e.target.value)} />
                    </Field>
                    <Field label="Tags">
                      <input className="cd-input" data-f="tags" value={tags} onChange={(e) => setTags(e.target.value)} />
                    </Field>
                  </div>
                  <Field label="Collections">
                    <CollectionChips
                      collections={collections}
                      selected={sel}
                      error={collectionsError}
                      onToggle={(id) => setSel((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))}
                    />
                  </Field>
                </div>
              </div>

              {stepNav("Preview it")}
            </div>
          </Card>
        )}

        {/* ---- Step: Preview ---- */}
        {step === "preview" && (
          <div className="npf-step" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <Segmented
                small
                options={[
                  { value: "page", label: "Listing page" },
                  { value: "grid", label: "In your store" },
                ]}
                value={previewView}
                onChange={(v) => setPreviewView(v as "page" | "grid")}
              />
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {readiness.map((r) => (
                  <span
                    key={r.label}
                    className="cd-badge"
                    style={{
                      background: r.done ? "var(--green-bg)" : "transparent",
                      color: r.done ? "var(--green)" : "var(--text-3)",
                      border: r.done ? "0" : "1px solid var(--hairline-strong)",
                    }}
                  >
                    {r.done && <CDIcon name="check" size={12} strokeWidth={2} />}
                    {r.label}
                  </span>
                ))}
              </div>
            </div>

            {previewView === "page" ? (
              /* The buyer's listing page. */
              <Card pad={false} className="npf-pv">
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", borderBottom: "1px solid var(--hairline)" }}>
                  <span style={{ display: "flex", gap: 4 }}>
                    {[0, 1, 2].map((i) => (
                      <span key={i} style={{ width: 8, height: 8, borderRadius: 999, background: "var(--hairline-strong)" }} />
                    ))}
                  </span>
                  <span
                    className="cd-caption tabular-nums"
                    style={{ flex: "1 1 0", textAlign: "center", background: "var(--gray-bg)", borderRadius: 999, padding: "4px 12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {listingUrl}
                  </span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 22, padding: 22 }}>
                  <button
                    type="button"
                    className="npf-pv-el"
                    onClick={() => fileRef.current?.click()}
                    aria-label={photos.length > 0 ? "Add more photos" : "Add photos"}
                    style={{
                      flex: "1 1 240px",
                      minWidth: 220,
                      aspectRatio: "1 / 1",
                      borderRadius: 12,
                      border: 0,
                      padding: 0,
                      cursor: "pointer",
                      background: "var(--gray-bg)",
                      color: "var(--text-3)",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 6,
                      overflow: "hidden",
                    }}
                  >
                    {photos.length > 0 ? (
                      <img src={photos[0].url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    ) : (
                      <>
                        <CDIcon name="image" size={26} />
                        <span className="cd-caption">Click to add photos</span>
                      </>
                    )}
                  </button>
                  <div style={{ flex: "1 1 260px", minWidth: 240, display: "flex", flexDirection: "column", gap: 10 }}>
                    <span className="cd-caption npf-pv-el">{(app.storeLabel || "Your store") + " / Products"}</span>
                    <div className="cd-h2 npf-pv-el" style={{ color: title.trim() ? "var(--text-1)" : "var(--text-3)" }}>
                      {title.trim() || "Product name"}
                    </div>
                    <div className="tabular-nums npf-pv-el" style={{ fontSize: 19, fontWeight: 650 }}>
                      {priceText}
                    </div>
                    {sizeValues.length > 0 && (
                      <div className="npf-pv-el" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {sizeValues.map((s, i) => (
                          <span
                            key={s}
                            className="cd-badge"
                            style={{
                              border: `1.5px solid ${i === 0 ? "var(--accent)" : "var(--hairline-strong)"}`,
                              color: i === 0 ? "var(--accent)" : "var(--text-2)",
                              minWidth: 34,
                              justifyContent: "center",
                            }}
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    )}
                    <div
                      aria-hidden="true"
                      className="npf-pv-el"
                      style={{
                        borderRadius: 10,
                        padding: "11px 0",
                        textAlign: "center",
                        fontWeight: 600,
                        fontSize: 14,
                        background: "var(--accent)",
                        color: "var(--on-accent)",
                        opacity: title.trim() && Number(price) > 0 ? 1 : 0.4,
                      }}
                    >
                      Add to cart
                    </div>
                    {desc.trim() && (
                      <p className="cd-caption npf-pv-el" style={{ lineHeight: 1.55 }}>
                        {desc}
                      </p>
                    )}
                  </div>
                </div>
              </Card>
            ) : (
              /* The store grid — your tile between neighbours; click it to open the page. */
              <div className="npf-pv" style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
                {[0, 1].map((gi) => (
                  <div key={gi} style={{ flex: "1 1 0", minWidth: 0, order: gi === 0 ? 0 : 2 }} aria-hidden="true">
                    <Card pad={false}>
                      <div style={{ aspectRatio: "1 / 1", background: "var(--gray-bg)", opacity: 0.55 }} />
                      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                        <span style={{ height: 10, width: "70%", borderRadius: 6, background: "var(--gray-bg)" }} />
                        <span style={{ height: 10, width: "36%", borderRadius: 6, background: "var(--gray-bg)" }} />
                      </div>
                    </Card>
                  </div>
                ))}
                <div style={{ flex: "1.2 1 0", minWidth: 0, order: 1 }}>
                  <Card pad={false} onClick={() => setPreviewView("page")} className="npf-pv-el">
                    <div style={{ aspectRatio: "1 / 1", background: "var(--gray-bg)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-3)", overflow: "hidden" }}>
                      {photos.length > 0 ? (
                        <img src={photos[0].url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      ) : (
                        <CDIcon name="image" size={24} />
                      )}
                    </div>
                    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 3 }}>
                      <span className="cd-row-title" style={{ color: title.trim() ? "var(--text-1)" : "var(--text-3)" }}>
                        {title.trim() || "Product name"}
                      </span>
                      <span className="tabular-nums cd-caption" style={{ fontWeight: 650, color: "var(--text-1)" }}>
                        {priceText}
                      </span>
                    </div>
                  </Card>
                </div>
              </div>
            )}

            <Card>
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-2" data-f="status" style={{ borderRadius: 10 }}>
                  {(
                    [
                      { v: "draft", label: "Save as draft", sub: "Not visible in your store yet" },
                      { v: "active", label: "Put on sale now", sub: "Buyers see it right away" },
                    ] as const
                  ).map((o) => {
                    const on = status === o.v;
                    return (
                      <button
                        key={o.v}
                        type="button"
                        onClick={() => setStatus(o.v)}
                        aria-pressed={on}
                        style={{
                          textAlign: "left",
                          padding: "11px 13px",
                          borderRadius: 12,
                          cursor: "pointer",
                          border: `1.5px solid ${on ? "var(--accent)" : "var(--hairline-strong)"}`,
                          background: on ? "var(--accent-bg)" : "transparent",
                        }}
                      >
                        <span className="cd-row-title" style={{ display: "block", color: on ? "var(--accent)" : "var(--text-1)" }}>
                          {o.label}
                        </span>
                        <span className="cd-caption">{o.sub}</span>
                      </button>
                    );
                  })}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <Btn onClick={() => setStep("details")} disabled={saving || drafting}>
                    Back
                  </Btn>
                  <Btn kind="primary" icon="check" disabled={saving || drafting} onClick={onSave}>
                    {saving ? "Saving…" : "Save product"}
                  </Btn>
                </div>
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
