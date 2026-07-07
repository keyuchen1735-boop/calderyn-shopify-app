// Search - the merchant SEO/AIO surface. Every storefront page is already
// optimized live (the engine writes meta + structured data on each render); this
// screen shows how each page looks to Google and AI assistants, and lets a
// merchant hand-edit a page's title/description (an override) or hand it back to
// the app. Seeds from the screen cache for instant paint, then refetches.
import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Card, Btn, Toggle, Pill, Placeholder, TableSkeleton } from "../ui";
import { CDIcon } from "../icons";
import { cachedScreenData, cacheScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import {
  fetchSearch,
  loadProductDetail,
  saveOverride,
  resetOverride,
  updateSettings,
  type SeoOverviewVM,
  type ProductSeoDetailVM,
  type SeoSettings,
} from "~/lib/dashboard/search-client";

// The counters guide the merchant toward the lengths Google shows in full; the
// hard caps match the server's validation bounds so a save can never be
// rejected for length while they type.
const TITLE_GUIDE = 60;
const TITLE_HARD = 70;
const DESC_GUIDE = 160;
const DESC_HARD = 200;

function healthTone(score: number): "success" | "warn" | "neutral" {
  return score >= 90 ? "success" : score >= 70 ? "warn" : "neutral";
}

// Plain, recognizable names for the AI-assistant crawlers a merchant would
// actually know. Unknown bots fall back to their own name rather than a blank.
const ASSISTANT_NAMES: Record<string, string> = {
  GPTBot: "ChatGPT",
  "OAI-SearchBot": "ChatGPT",
  ChatGPT: "ChatGPT",
  "ChatGPT-User": "ChatGPT",
  PerplexityBot: "Perplexity",
  "Perplexity-User": "Perplexity",
  ClaudeBot: "Claude",
  "Claude-Web": "Claude",
  "anthropic-ai": "Claude",
  "Google-Extended": "Google AI",
  Applebot: "Apple",
  "Applebot-Extended": "Apple",
  Amazonbot: "Amazon",
  Bytespider: "TikTok",
  "Meta-ExternalAgent": "Meta AI",
  "cohere-ai": "Cohere",
  CCBot: "Common Crawl",
};

function assistantName(botName: string): string {
  return ASSISTANT_NAMES[botName] ?? botName;
}

// A short, human list of the assistants that visited: friendly names, de-duped,
// top few, joined for a single readable sentence.
function assistantList(crawls: SeoOverviewVM["aiCrawls"], max = 3): string {
  const seen: string[] = [];
  for (const c of crawls) {
    const name = assistantName(c.botName);
    if (!seen.includes(name)) seen.push(name);
    if (seen.length >= max) break;
  }
  return seen.join(", ");
}

// Shared by the initial mount and the Retry button, so a failed load and a
// successful retry both funnel through one place: cache and show the fresh
// overview on success, or flag the friendly error state on failure.
export async function loadSearchOverview(
  setData: (state: SeoOverviewVM) => void,
  setLoadError: (failed: boolean) => void,
): Promise<void> {
  try {
    const state = await fetchSearch();
    cacheScreenData(SCREEN_CACHE_KEYS.search, state);
    setData(state);
    setLoadError(false);
  } catch {
    setLoadError(true);
  }
}

export default function Search({ app }: { app: DashboardCtx }) {
  const [data, setData] = useState<SeoOverviewVM | null>(() =>
    cachedScreenData<SeoOverviewVM>(SCREEN_CACHE_KEYS.search),
  );
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState<string | null>(null); // product handle

  useEffect(() => {
    let live = true;
    loadSearchOverview(
      (state) => {
        if (!live) return;
        setData(state);
      },
      (failed) => {
        if (!live) return;
        setLoadError(failed);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  function refresh() {
    loadSearchOverview(setData, setLoadError);
  }

  if (!data) {
    if (loadError) {
      return (
        <Placeholder
          icon="warn"
          title="We couldn't load your Search data right now."
          actionLabel="Try again"
          onAction={refresh}
        />
      );
    }
    return <TableSkeleton />;
  }

  if (editing) {
    return (
      <ProductEditor
        app={app}
        handle={editing}
        onBack={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />
    );
  }

  const hasProducts = data.productCount > 0;

  return (
    <div className="cd-screen cd-seo">
      <header className="cd-seo__head">
        <div className="cd-seo__head-text">
          <h1 className="cd-seo__title">Search</h1>
          <p className="cd-seo__lede">How your store looks to Google and AI assistants.</p>
        </div>
        {hasProducts && (
          <div className="cd-seo__health" data-tone={healthTone(data.storeHealth)}>
            <span className="cd-seo__health-lab">Store health</span>
            <span className="cd-seo__health-val">
              <b>{data.storeHealth}</b>
              <i>/100</i>
            </span>
          </div>
        )}
      </header>

      {!hasProducts ? (
        <Placeholder
          icon="search"
          title="Nothing to optimize yet"
          sub="Add a product and it's automatically optimized for search and AI."
        />
      ) : (
        <>
          <div className="cd-seo__cards">
            <Card>
              <div className="cd-seo__card-head">
                <CDIcon name="search" size={17} strokeWidth={1.8} />
                <span>On Google</span>
              </div>
              <p className="cd-seo__card-sub">
                See where your pages show up in Google search.
              </p>
              <div className="cd-seo__card-foot">
                <Btn kind="secondary" small disabled>
                  Connect Google
                </Btn>
                <span className="cd-seo__soon">Coming soon</span>
              </div>
            </Card>

            <Card>
              <div className="cd-seo__card-head">
                <CDIcon name="sparkle" size={17} strokeWidth={1.8} />
                <span>On AI assistants</span>
              </div>
              {data.aiCrawlTotal > 0 ? (
                <p className="cd-seo__card-sub">
                  Read{" "}
                  <b className="cd-seo__strong">{data.aiCrawlTotal.toLocaleString()}</b> times by{" "}
                  {assistantList(data.aiCrawls)}.
                </p>
              ) : (
                <p className="cd-seo__card-sub">
                  No AI assistant visits yet. Your store is set up to be read and cited.
                </p>
              )}
            </Card>
          </div>

          <section className="cd-seo__section">
            <h2 className="cd-h2">Pages that need a look</h2>
            {data.needsAttention.length === 0 ? (
              <Card>
                <div className="cd-seo__allgood">
                  <span className="cd-seo__allgood-ic">
                    <CDIcon name="check" size={16} strokeWidth={2.1} />
                  </span>
                  <span>Every page looks good.</span>
                </div>
              </Card>
            ) : (
              <Card pad={false}>
                <div className="cd-seo__rows">
                  {data.needsAttention.map((row) => (
                    <div key={row.id} className="cd-seo__row">
                      <div className="cd-seo__row-main">
                        <span className="cd-seo__row-title">{row.title}</span>
                        <span className="cd-seo__row-issue">
                          {row.topIssue ?? "Could be stronger"}
                          {row.hasOverride && (
                            <span className="cd-seo__edited"> · edited by you</span>
                          )}
                        </span>
                      </div>
                      <Pill tone={healthTone(row.score)}>{row.score}</Pill>
                      <Btn small kind="primary" onClick={() => setEditing(row.handle)}>
                        Fix it
                      </Btn>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </section>
        </>
      )}

      <SettingsPanel app={app} settings={data.settings} onSaved={refresh} />
    </div>
  );
}

// Shared by ProductEditor's initial mount and its Retry button, mirroring
// loadSearchOverview above: the caller decides what a successful load or a
// failure means for its own state.
export async function loadSearchProductDetail(
  handle: string,
  onLoaded: (detail: ProductSeoDetailVM) => void,
  onError: () => void,
): Promise<void> {
  try {
    onLoaded(await loadProductDetail(handle));
  } catch {
    onError();
  }
}

// The product editor's failed-load state: a calm explanation plus a way back
// and a way to try the same page again, instead of stranding a merchant on an
// endless skeleton.
export function ProductLoadError({
  onBack,
  onRetry,
}: {
  onBack: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="cd-screen cd-seo cd-seo--editor">
      <Placeholder icon="warn" title="We couldn't load this page." />
      <div className="cd-seo__actions justify-center">
        <Btn kind="secondary" onClick={onBack}>
          Back
        </Btn>
        <Btn kind="primary" onClick={onRetry}>
          Try again
        </Btn>
      </div>
    </div>
  );
}

function ProductEditor({
  app,
  handle,
  onBack,
  onSaved,
}: {
  app: DashboardCtx;
  handle: string;
  onBack: () => void;
  onSaved: () => void;
}) {
  const [detail, setDetail] = useState<ProductSeoDetailVM | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const { toast } = app;

  useEffect(() => {
    let live = true;
    loadSearchProductDetail(
      handle,
      (d) => {
        if (!live) return;
        setDetail(d);
        setTitle(d.override?.metaTitle ?? d.googlePreview.title);
        setDescription(d.override?.metaDescription ?? d.googlePreview.description);
        setLoadError(false);
      },
      () => {
        if (!live) return;
        setLoadError(true);
        toast("Could not load that page", "warn", "critical");
      },
    );
    return () => {
      live = false;
    };
  }, [handle, toast]);

  function retry() {
    loadSearchProductDetail(
      handle,
      (d) => {
        setDetail(d);
        setTitle(d.override?.metaTitle ?? d.googlePreview.title);
        setDescription(d.override?.metaDescription ?? d.googlePreview.description);
        setLoadError(false);
      },
      () => {
        setLoadError(true);
        toast("Could not load that page", "warn", "critical");
      },
    );
  }

  if (!detail) {
    if (loadError) return <ProductLoadError onBack={onBack} onRetry={retry} />;
    return <TableSkeleton rows={4} />;
  }

  const preview =
    mode === "edit"
      ? {
          title: title.trim() || detail.googlePreview.title,
          url: detail.googlePreview.url,
          description: description.trim() || detail.googlePreview.description,
        }
      : detail.googlePreview;

  async function onSave() {
    if (!detail) return;
    setSaving(true);
    try {
      await saveOverride({
        entityId: detail.id,
        metaTitle: title.trim(),
        metaDescription: description.trim(),
      });
      toast("Saved. Your storefront is updated.", "check");
      onSaved();
    } catch {
      toast("Could not save", "warn", "critical");
    } finally {
      setSaving(false);
    }
  }

  async function onLetAppWrite() {
    if (!detail) return;
    setSaving(true);
    try {
      await resetOverride(detail.id);
      toast("Back to the auto-written version.", "sparkle");
      onSaved();
    } catch {
      toast("Could not reset", "warn", "critical");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cd-screen cd-seo cd-seo--editor">
      <button type="button" className="cd-seo__back" onClick={onBack}>
        <CDIcon name="chevronLeft" size={16} strokeWidth={2} />
        Back
      </button>
      <h1 className="cd-seo__title">{detail.title}</h1>

      <section className="cd-seo__section">
        <h2 className="cd-h2">How you look on Google</h2>
        <Card>
          <div className="cd-serp">
            <div className="cd-serp__url">{preview.url.replace(/^https?:\/\//, "")}</div>
            <div className="cd-serp__title">{preview.title}</div>
            <div className="cd-serp__desc">{preview.description}</div>
          </div>
        </Card>
      </section>

      <section className="cd-seo__section">
        <div className="cd-seo__checkhead">
          <h2 className="cd-h2">Health checks</h2>
          <span className="cd-seo__health-inline" data-tone={healthTone(detail.health.score)}>
            {detail.health.score}/100
          </span>
        </div>
        <Card pad={false}>
          <div className="cd-seo__checks">
            {detail.health.checks.map((c) => (
              <div key={c.id} className="cd-seo__check" data-status={c.status}>
                <span className="cd-seo__check-ic">
                  <CDIcon
                    name={c.status === "pass" ? "check" : c.status === "warn" ? "warn" : "x"}
                    size={14}
                    strokeWidth={2.2}
                  />
                </span>
                <span className="cd-seo__check-body">
                  <span className="cd-seo__check-label">{c.label}</span>
                  {c.status !== "pass" && c.hint && (
                    <span className="cd-seo__check-hint">{c.hint}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </section>

      {mode === "view" ? (
        <div className="cd-seo__actions">
          <Btn kind="secondary" onClick={onLetAppWrite} disabled={saving || !detail.override}>
            Let the app write it
          </Btn>
          <Btn kind="primary" onClick={() => setMode("edit")}>
            Edit myself
          </Btn>
        </div>
      ) : (
        <section className="cd-seo__section cd-seo__edit">
          <h2 className="cd-h2">Write it yourself</h2>
          <Card>
            <div className="cd-seo__form">
              <label className="cd-field">
                <span>Title</span>
                <input
                  className="cd-input"
                  value={title}
                  maxLength={TITLE_HARD}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <small className="cd-seo__count" data-over={title.trim().length > TITLE_GUIDE ? "1" : "0"}>
                  {title.trim().length}/{TITLE_GUIDE}
                </small>
              </label>
              <label className="cd-field">
                <span>Description</span>
                <textarea
                  className="cd-input"
                  value={description}
                  rows={3}
                  maxLength={DESC_HARD}
                  onChange={(e) => setDescription(e.target.value)}
                />
                <small
                  className="cd-seo__count"
                  data-over={description.trim().length > DESC_GUIDE ? "1" : "0"}
                >
                  {description.trim().length}/{DESC_GUIDE}
                </small>
              </label>
              <div className="cd-seo__actions">
                <Btn kind="secondary" onClick={() => setMode("view")} disabled={saving}>
                  Cancel
                </Btn>
                <Btn
                  kind="primary"
                  onClick={onSave}
                  disabled={saving || !title.trim() || !description.trim()}
                >
                  {saving ? "Saving..." : "Save"}
                </Btn>
              </div>
            </div>
          </Card>
        </section>
      )}
    </div>
  );
}

function SettingsPanel({
  app,
  settings,
  onSaved,
}: {
  app: DashboardCtx;
  settings: SeoSettings;
  onSaved: () => void;
}) {
  const [orgName, setOrgName] = useState(settings.orgName ?? "");
  const [orgDescription, setOrgDescription] = useState(settings.orgDescription ?? "");
  const [savingCrawl, setSavingCrawl] = useState(false);
  const [savingOrg, setSavingOrg] = useState(false);

  // Re-seed the editable fields whenever a fresh settings prop arrives (e.g.
  // after a refresh elsewhere on the screen), so a stale value from the first
  // mount never lingers in the form.
  useEffect(() => {
    setOrgName(settings.orgName ?? "");
    setOrgDescription(settings.orgDescription ?? "");
  }, [settings.orgName, settings.orgDescription]);

  async function toggleCrawlers(next: boolean) {
    setSavingCrawl(true);
    try {
      await updateSettings({ allowAiCrawlers: next });
      app.toast(
        next ? "AI assistants can read your store." : "AI assistants asked not to read your store.",
        "check",
      );
      onSaved();
    } catch {
      app.toast("Could not update", "warn", "critical");
    } finally {
      setSavingCrawl(false);
    }
  }

  async function saveOrg() {
    setSavingOrg(true);
    try {
      await updateSettings({
        orgName: orgName.trim() || null,
        orgDescription: orgDescription.trim() || null,
      });
      app.toast("Saved.", "check");
      onSaved();
    } catch {
      app.toast("Could not save", "warn", "critical");
    } finally {
      setSavingOrg(false);
    }
  }

  return (
    <section className="cd-seo__section cd-seo__settings">
      <h2 className="cd-h2">Settings</h2>
      <Card>
        <div className="cd-seo__setrow">
          <div className="cd-seo__setinfo">
            <div className="cd-seo__setlabel">Let AI assistants read and cite my store</div>
            <div className="cd-seo__sethint">
              On by default. Turn this off to ask assistants like ChatGPT and Perplexity not to read
              your store.
            </div>
          </div>
          <Toggle
            value={settings.allowAiCrawlers}
            onChange={toggleCrawlers}
            disabled={savingCrawl}
            ariaLabel="Let AI assistants read and cite my store"
          />
        </div>

        <div className="cd-seo__setdiv" />

        <div className="cd-seo__setblock">
          <div className="cd-seo__setlabel">How your store is described</div>
          <div className="cd-seo__form">
            <label className="cd-field">
              <span>Store name</span>
              <input
                className="cd-input"
                value={orgName}
                maxLength={80}
                onChange={(e) => setOrgName(e.target.value)}
              />
            </label>
            <label className="cd-field">
              <span>One-line description</span>
              <input
                className="cd-input"
                value={orgDescription}
                maxLength={200}
                onChange={(e) => setOrgDescription(e.target.value)}
              />
            </label>
            <div>
              <Btn kind="primary" small onClick={saveOrg} disabled={savingOrg}>
                {savingOrg ? "Saving..." : "Save"}
              </Btn>
            </div>
          </div>
        </div>
      </Card>
    </section>
  );
}
