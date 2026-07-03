import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Btn, Placeholder } from "../ui";
import { CDIcon } from "../icons";
import { money, timeAgo } from "../format";
import { DashboardApiError } from "~/lib/dashboard/client";
import { cacheScreenData, cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import {
  addProductFromImage,
  fetchStudio,
  saveStudioHero,
  setStudioAccent,
  generateStudioStore,
  publishStudioStore,
  type StudioState,
  type StudioHero,
} from "~/lib/dashboard/store-client";
import { buildStep, missingPieces, type BuildPhase, type MissingPiece } from "./store-logic";
import type { DashboardCtx } from "../context";

type Tool = "select" | "edit" | "comment" | "markup" | "tweak";

const TOOLS: { key: Tool; icon: string; title: string }[] = [
  { key: "select", icon: "cursor", title: "Select" },
  { key: "edit", icon: "pencil", title: "Edit copy" },
  { key: "comment", icon: "comment", title: "Comment (session note)" },
  { key: "markup", icon: "pen", title: "Markup (session sketch)" },
  { key: "tweak", icon: "sliders", title: "Tweak accent" },
];

const SWATCHES = ["#2D7FF9", "#1F8A5B", "#C2410C", "#7C5CFC"];

const QUICK_PROMPTS = [
  "A minimal home page that leads with our bestsellers",
  "A warm, earthy brand voice with a bold hero",
  "A seasonal sale layout with a strong call to action",
];

// What the storefront really renders when no doc exists yet — the default home
// document's hero copy (app/lib/storebuilder/default-doc.ts).
const DEFAULT_HERO: StudioHero = { headline: "Welcome", subhead: "Shop our latest" };

const GEN_LABEL: Record<string, string> = {
  draft: "draft ready",
  failed: "failed",
  no_products: "draft ready — no products",
};

interface Pin {
  id: number;
  x: number;
  y: number;
  text: string;
}

// Once-per-SPA-session guard for the first-visit auto-build. Module-scoped so
// remounts (navigate away and back) can't re-fire a generation while one is
// already running or after one failed — the server's generation audit row only
// lands when a run completes.
let autoBuildAttempted = false;

const clampPct = (v: number): number => Math.min(100, Math.max(0, v));

function pctPoint(e: ReactPointerEvent<HTMLElement> | ReactMouseEvent<HTMLElement>): {
  x: number;
  y: number;
} {
  const rect = e.currentTarget.getBoundingClientRect();
  return {
    x: clampPct(((e.clientX - rect.left) / rect.width) * 100),
    y: clampPct(((e.clientY - rect.top) / rect.height) * 100),
  };
}

export default function Store({ app }: { app: DashboardCtx }) {
  const toast = app.toast;
  // Seeded from the session cache so a return visit paints instantly; the
  // mount refresh below revalidates and writes back through.
  const [data, setData] = useState<StudioState | null>(() =>
    cachedScreenData<StudioState>(SCREEN_CACHE_KEYS.storeStudio),
  );
  const [loading, setLoading] = useState(true);
  const [tool, setTool] = useState<Tool>("select");

  // Session-local annotations — pins and markup strokes live in component
  // state only and are never persisted.
  const [pins, setPins] = useState<Pin[]>([]);
  const [pending, setPending] = useState<{ x: number; y: number } | null>(null);
  const [pendingText, setPendingText] = useState("");
  const pinSeq = useRef(0);
  const [strokes, setStrokes] = useState<string[]>([]);
  const drawing = useRef<string[] | null>(null);

  const [prompt, setPrompt] = useState("");
  const [buildPhase, setBuildPhase] = useState<BuildPhase | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [accentBusy, setAccentBusy] = useState(false);
  // Pre-publish warning panel visibility. The pieces themselves are derived
  // from `data` at render so they can never go stale. Warn-only: the panel
  // offers to fix each piece inline, but "Publish anyway" always proceeds.
  const [confirmingPublish, setConfirmingPublish] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const s = await fetchStudio();
    cacheScreenData(SCREEN_CACHE_KEYS.storeStudio, s);
    if (aliveRef.current) setData(s);
  }, []);

  useEffect(() => {
    setLoading(true);
    refresh()
      .catch((err: unknown) => {
        if (!aliveRef.current) return;
        const msg =
          err instanceof DashboardApiError ? err.message : "Could not load your store.";
        toast(msg, "warn", "critical");
      })
      .finally(() => {
        if (aliveRef.current) setLoading(false);
      });
  }, [refresh, toast]);

  const building = buildPhase?.kind === "running";
  const hero = data?.hero ?? DEFAULT_HERO;
  const accent = data?.settings.accent ?? "#0f766e";
  const storefrontPath = data?.storefrontPath ?? "/storefront";

  const openStorefront = () => {
    window.open(storefrontPath, "_blank", "noopener");
  };

  // --- edit tool: contentEditable hero copy -------------------------------
  // save-hero persists BOTH fields, so payloads must build from the LATEST
  // committed copy (a render-closure `hero` can be stale when both fields are
  // edited back-to-back) and saves must run one at a time; publish awaits the
  // chain so it never snapshots a draft mid-save.
  const heroRef = useRef<StudioHero>(DEFAULT_HERO);
  useEffect(() => {
    heroRef.current = hero;
  }, [hero]);
  const heroSaveChain = useRef<Promise<void>>(Promise.resolve());

  const commitHero = (field: keyof StudioHero, el: HTMLElement): Promise<void> => {
    const next = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    const run = async () => {
      const prev = heroRef.current[field];
      if (next === prev) return;
      if (field === "headline" && !next) {
        el.textContent = prev;
        toast("Headline can't be empty.", "warn", "critical");
        return;
      }
      try {
        const saved = await saveStudioHero({ ...heroRef.current, [field]: next });
        heroRef.current = saved;
        if (!aliveRef.current) return;
        // save-hero writes the draft doc, so hasDraft is now genuinely true.
        setData((d) => (d ? { ...d, hero: saved, hasDraft: true } : d));
        toast("Copy updated");
      } catch (err) {
        el.textContent = prev;
        if (!aliveRef.current) return;
        const msg = err instanceof DashboardApiError ? err.message : "Could not save copy.";
        toast(msg, "warn", "critical");
      }
    };
    heroSaveChain.current = heroSaveChain.current.then(run);
    return heroSaveChain.current;
  };

  const heroBlur = (field: keyof StudioHero) => (e: ReactFocusEvent<HTMLElement>) => {
    void commitHero(field, e.currentTarget);
  };

  const heroKeyDown = (field: keyof StudioHero) => (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.currentTarget.textContent = hero[field];
      e.currentTarget.blur();
    }
  };

  // --- comment tool --------------------------------------------------------
  const onCommentClick = (e: ReactMouseEvent<HTMLButtonElement>) => {
    setPending(pctPoint(e));
    setPendingText("");
  };

  const pinInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && pending && pendingText.trim()) {
      pinSeq.current += 1;
      setPins((p) => [...p, { id: pinSeq.current, x: pending.x, y: pending.y, text: pendingText.trim() }]);
      setPending(null);
      setPendingText("");
    } else if (e.key === "Escape") {
      setPending(null);
      setPendingText("");
    }
  };

  // --- markup tool ----------------------------------------------------------
  const onDrawStart = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pctPoint(e);
    drawing.current = [`${p.x.toFixed(2)} ${p.y.toFixed(2)}`];
    setStrokes((s) => [...s, `M ${p.x.toFixed(2)} ${p.y.toFixed(2)}`]);
  };

  const onDrawMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drawing.current) return;
    const p = pctPoint(e);
    drawing.current.push(`${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
    const pts = drawing.current;
    const d = `M ${pts[0]}` + pts.slice(1).map((pt) => ` L ${pt}`).join("");
    setStrokes((s) => [...s.slice(0, -1), d]);
  };

  const onDrawEnd = () => {
    drawing.current = null;
  };

  const clearMarks = () => {
    setStrokes([]);
    setPins([]);
    setPending(null);
    setPendingText("");
  };

  // --- tweak tool -------------------------------------------------------------
  const applyAccent = async (color: string) => {
    if (accentBusy) return;
    setAccentBusy(true);
    try {
      const saved = await setStudioAccent(color);
      if (aliveRef.current) {
        setData((d) => (d ? { ...d, settings: { ...d.settings, accent: saved } } : d));
      }
    } catch (err) {
      if (aliveRef.current) {
        const msg =
          err instanceof DashboardApiError ? err.message : "Could not update the accent.";
        toast(msg, "warn", "critical");
      }
    } finally {
      if (aliveRef.current) setAccentBusy(false);
    }
  };

  // --- generate + publish -------------------------------------------------------
  const runBuild = useCallback(
    async (brief: string) => {
      if (building) return;
      setBuildPhase({ kind: "running" });
      try {
        const receipt = await generateStudioStore(brief.trim());
        // Re-pull the whole studio state — generation rewrites brand settings,
        // drafts and the generation audit row.
        await refresh();
        if (!aliveRef.current) return;
        setBuildPhase({ kind: "done", status: receipt.status });
      } catch (err) {
        if (!aliveRef.current) return;
        const msg =
          err instanceof DashboardApiError ? err.message : "Store generation failed.";
        setBuildPhase({ kind: "failed", message: msg });
        toast(msg, "warn", "critical");
      }
    },
    [building, refresh, toast],
  );

  // First visit with nothing built yet: kick off a design immediately instead
  // of waiting for a prompt — the merchant lands on a drafted store. The
  // once-guard is module-scoped (below, outside the component) because the
  // store_generation row is only written when a run finishes, so a per-mount
  // ref would re-fire the build on every navigate-away-and-back mid-run.
  useEffect(() => {
    if (loading || !data || autoBuildAttempted) return;
    if (data.hasDraft || data.hasPublished || data.generation) return;
    autoBuildAttempted = true;
    void runBuild("");
  }, [loading, data, runBuild]);

  // Chat-box attachments → draft products (title from filename, image attached).
  const onAttachFiles = async (e: ReactChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.currentTarget.files ?? []);
    e.currentTarget.value = "";
    if (files.length === 0) return;
    if (attaching) {
      toast("Still adding the previous images — try again in a moment.");
      return;
    }
    setAttaching(true);
    const results = await Promise.allSettled(files.map((file) => addProductFromImage(file)));
    if (!aliveRef.current) return;
    results.forEach((r, i) => {
      if (r.status === "fulfilled" && !r.value.imageError) {
        toast(`Added "${r.value.title}" as a draft product`);
      } else if (r.status === "fulfilled") {
        // Partial add: the product exists but has no image — say so, or a
        // retry would mint a duplicate.
        toast(`Added draft "${r.value.title}", but its image failed to upload — add one in Products.`, "warn", "critical");
      } else {
        const msg = r.reason instanceof DashboardApiError ? r.reason.message : "upload failed";
        toast(`Couldn't add "${files[i].name}" — ${msg}`, "warn", "critical");
      }
    });
    try {
      await refresh();
    } finally {
      if (aliveRef.current) setAttaching(false);
    }
  };

  // Publish click: warn about missing pieces first (products, payments) with
  // inline fixes — but never gate. "Publish anyway" runs the same publish.
  const publishPieces: MissingPiece[] = data ? missingPieces(data) : [];
  const onPublishClick = () => {
    if (!data || publishing) return;
    if (publishPieces.length > 0) {
      setConfirmingPublish(true);
      return;
    }
    void runPublish();
  };

  const runPublish = async () => {
    if (publishing) return;
    setConfirmingPublish(false);
    setPublishing(true);
    try {
      // Flush any in-flight hero save first, so the published snapshot matches
      // the copy on screen (clicking Publish blurs a focused field, which
      // queues a save in the same tick).
      await heroSaveChain.current;
      await publishStudioStore();
      if (!aliveRef.current) return;
      setData((d) => (d ? { ...d, hasPublished: true } : d));
      toast("Published to your storefront");
    } catch (err) {
      if (!aliveRef.current) return;
      const msg = err instanceof DashboardApiError ? err.message : "Could not publish.";
      toast(msg, "warn", "critical");
    } finally {
      if (aliveRef.current) setPublishing(false);
    }
  };

  // --- render ----------------------------------------------------------------
  if (!data) {
    return (
      <div className="cd-screen cd-screen-storefront" data-screen-label="Store">
        <div className="cd-studio">
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Placeholder
              icon="store"
              title={loading ? "Loading your store" : "Store unavailable"}
              sub={
                loading
                  ? "Reading your storefront draft and brand kit."
                  : "Could not load the studio just now. Refresh to try again."
              }
            />
          </div>
        </div>
      </div>
    );
  }

  const stateAttr = building ? "building" : data.hasPublished ? "built" : "idle";
  const stateLabel = building ? "Building" : data.hasPublished ? "Live" : data.hasDraft ? "Draft" : "Idle";
  const step = buildPhase ? buildStep(buildPhase) : null;
  const editing = tool === "edit";

  return (
    <div className="cd-screen cd-screen-storefront" data-screen-label="Store">
      <div className="cd-studio">
        <div className="cd-studio-bar">
          <div className="cd-dot3" aria-hidden="true">
            <i style={{ background: "var(--red)" }} />
            <i style={{ background: "var(--orange)" }} />
            <i style={{ background: "var(--green)" }} />
          </div>
          <button
            type="button"
            className="cd-url"
            style={{ border: 0, cursor: "pointer", font: "inherit", fontSize: 12 }}
            onClick={openStorefront}
            title="Open your storefront in a new tab"
          >
            {storefrontPath}
          </button>
          <span className="cd-build-state" data-state={stateAttr}>
            {stateLabel}
          </span>
          <div className="cd-studio-tools">
            {TOOLS.map((t) => (
              <button
                key={t.key}
                type="button"
                className="cd-tool"
                data-active={tool === t.key ? "1" : "0"}
                title={t.title}
                aria-label={t.title}
                onClick={() => setTool(t.key)}
              >
                <CDIcon name={t.icon} size={15} strokeWidth={1.9} />
              </button>
            ))}
          </div>
          {(strokes.length > 0 || pins.length > 0) && (
            <Btn small onClick={clearMarks}>
              Clear
            </Btn>
          )}
          <Btn kind="primary" small onClick={onPublishClick} disabled={publishing || building}>
            {publishing ? "Publishing…" : "Publish"}
          </Btn>
        </div>

        <div className="cd-studio-canvas" data-tool={tool}>
          <div className="cd-canvas-page">
            <div className="cd-store">
              <div
                className="cd-store-hero"
                style={{
                  background: `linear-gradient(135deg, color-mix(in srgb, ${accent} 18%, var(--card-solid)), var(--card-solid))`,
                }}
              >
                <div
                  className="cd-store-eyebrow"
                  data-editable="1"
                  role="textbox"
                  aria-label="Hero subhead"
                  tabIndex={editing ? 0 : undefined}
                  contentEditable={editing}
                  suppressContentEditableWarning
                  style={{ color: accent }}
                  onBlur={heroBlur("subhead")}
                  onKeyDown={heroKeyDown("subhead")}
                >
                  {hero.subhead}
                </div>
                <h2
                  className="cd-store-h"
                  data-editable="1"
                  role="textbox"
                  aria-label="Hero headline"
                  tabIndex={editing ? 0 : undefined}
                  contentEditable={editing}
                  suppressContentEditableWarning
                  onBlur={heroBlur("headline")}
                  onKeyDown={heroKeyDown("headline")}
                >
                  {hero.headline}
                </h2>
                <span className="cd-store-cta" style={{ background: accent }}>
                  Shop now
                </span>
              </div>
              <div className="cd-store-grid">
                {data.products.length === 0 ? (
                  <div className="cd-caption" style={{ gridColumn: "1 / -1", padding: "10px 0" }}>
                    {data.draftProductCount > 0
                      ? `${data.draftProductCount} draft product${
                          data.draftProductCount === 1 ? "" : "s"
                        } waiting — finish them in Products to show them here.`
                      : "No products yet. Attach images below to add them."}
                  </div>
                ) : (
                  data.products.map((p) => (
                    <div key={p.id}>
                      {p.imageUrl ? (
                        <img
                          src={p.imageUrl}
                          alt={p.title}
                          style={{
                            width: "100%",
                            aspectRatio: "1",
                            objectFit: "cover",
                            borderRadius: 8,
                            display: "block",
                          }}
                        />
                      ) : (
                        <div
                          aria-hidden="true"
                          style={{
                            width: "100%",
                            aspectRatio: "1",
                            background: "var(--gray-bg)",
                            borderRadius: 8,
                          }}
                        />
                      )}
                      <div className="cd-store-prod-name">{p.title}</div>
                      <div className="cd-store-prod-price">
                        {p.priceCents != null ? money(p.priceCents) : "—"}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <svg
              className="cd-mark-layer"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {strokes.map((d, i) => (
                <path
                  key={i}
                  d={d}
                  fill="none"
                  stroke="var(--live)"
                  strokeWidth={1.4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>

            {(tool === "comment" || tool === "markup") && (
              <button
                type="button"
                className="cd-capture"
                aria-label={tool === "comment" ? "Add a session note pin" : "Draw session markup"}
                style={{
                  background: "transparent",
                  border: 0,
                  padding: 0,
                  cursor: "crosshair",
                  touchAction: "none",
                }}
                onClick={tool === "comment" ? onCommentClick : undefined}
                onPointerDown={tool === "markup" ? onDrawStart : undefined}
                onPointerMove={tool === "markup" ? onDrawMove : undefined}
                onPointerUp={tool === "markup" ? onDrawEnd : undefined}
                onPointerCancel={tool === "markup" ? onDrawEnd : undefined}
              />
            )}

            {pins.map((p, i) => (
              <div
                key={p.id}
                className="cd-pin"
                style={{ left: `${p.x}%`, top: `${p.y}%` }}
                title={p.text}
              >
                {i + 1}
              </div>
            ))}

            {pending && (
              <div className="cd-pin-input" style={{ left: `${pending.x}%`, top: `${pending.y}%` }}>
                <input
                  autoFocus
                  value={pendingText}
                  placeholder="Note (this session only)"
                  aria-label="Session note"
                  onChange={(e) => setPendingText(e.target.value)}
                  onKeyDown={pinInputKeyDown}
                />
              </div>
            )}
          </div>

          {step && buildPhase && (
            <div className="cd-build-float">
              <div className="cd-buildlist">
                <div className="cd-build-step">
                  <span
                    className="cd-build-dot"
                    data-st={step.dot}
                    style={step.dotColor ? { background: step.dotColor } : undefined}
                  />
                  <div>
                    <div className="cd-build-title">{step.title}</div>
                    <div className="cd-build-sub">{step.sub}</div>
                  </div>
                </div>
              </div>
              {buildPhase.kind !== "running" && (
                <div style={{ padding: "0 18px 10px" }}>
                  <button type="button" className="cd-chip" onClick={() => setBuildPhase(null)}>
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          )}

          {confirmingPublish && publishPieces.length > 0 && (
            <div className="cd-build-float" role="alertdialog" aria-label="Before you publish">
              <div className="cd-buildlist">
                {publishPieces.map((piece) => (
                  <div key={piece.key} className="cd-build-step">
                    <span className="cd-build-dot" data-st="wait" style={{ background: "var(--orange)" }} />
                    <div>
                      <div className="cd-build-title">{piece.label}</div>
                      <button
                        type="button"
                        className="cd-chip"
                        style={{ marginTop: 6 }}
                        onClick={() => {
                          setConfirmingPublish(false);
                          app.navigate(piece.screen);
                        }}
                      >
                        {piece.action}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, padding: "0 18px 12px" }}>
                <Btn
                  kind="primary"
                  small
                  onClick={() => void runPublish()}
                  disabled={publishing || building}
                >
                  Publish anyway
                </Btn>
                <Btn small onClick={() => setConfirmingPublish(false)}>
                  Keep editing
                </Btn>
              </div>
            </div>
          )}

          {tool === "tweak" && (
            <div className="cd-tweak-pop">
              <div className="cd-build-title">Accent color</div>
              <div className="cd-build-sub">Saved to your storefront brand kit.</div>
              <div className="cd-swatches">
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="cd-swatch"
                    style={{ background: c }}
                    data-active={c.toLowerCase() === accent.toLowerCase() ? "1" : "0"}
                    aria-label={`Set accent ${c}`}
                    disabled={accentBusy}
                    onClick={() => void applyAccent(c)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="cd-studio-foot">
          <div className="cd-prompt-row">
            <span className="cd-prompt-ic">
              <CDIcon name="sparkle" size={18} />
            </span>
            <textarea
              className="cd-prompt-in"
              rows={1}
              placeholder="Describe a page or change…"
              aria-label="Describe a page or change"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={(e) => void onAttachFiles(e)}
            />
            <button
              type="button"
              className="cd-tool"
              title="Attach images to add products"
              aria-label="Attach images to add products"
              disabled={attaching}
              onClick={() => fileInputRef.current?.click()}
            >
              <CDIcon name="paperclip" size={15} strokeWidth={1.9} />
            </button>
            <Btn kind="primary" onClick={() => void runBuild(prompt)} disabled={building}>
              {building ? "Building…" : "Build"}
            </Btn>
          </div>
          <div className="cd-prompt-chips">
            {QUICK_PROMPTS.map((c) => (
              <button key={c} type="button" className="cd-chip" onClick={() => setPrompt(c)}>
                {c}
              </button>
            ))}
            {data.generation && (
              <span className="cd-caption" style={{ marginLeft: "auto", alignSelf: "center" }}>
                Last build {timeAgo(data.generation.createdAt)} ·{" "}
                {GEN_LABEL[data.generation.status] ?? data.generation.status}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
