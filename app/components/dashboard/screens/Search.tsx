// Search - the merchant SEO/AIO surface (Store > Preferences). Every storefront
// page is already optimized live (the engine writes meta + structured data on
// each render), so this screen shows the proof instead of asserting it: a real
// Google result and an example AI answer for one of the store's own products,
// then the two controls a merchant actually has. Seeds from the screen cache for
// instant paint, then refetches.
import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Card, Btn, Toggle, Placeholder, TableSkeleton } from "../ui";
import { CDIcon } from "../icons";
import { cachedScreenData, cacheScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import { fetchSearchOverview, updateSettings, type SearchOverviewVM } from "~/lib/dashboard/search-client";

// Store-description hard cap: mirrors the server's own bound (see
// dashboard.api.search.tsx), so a save can never be rejected for length.
const DESCRIPTION_MAX = 200;

// The engine's meta title is "<product> · <store>"; the bare product name reads
// better inside a spoken AI answer. Split on the writer's own separator, falling
// back to the whole title when it is absent (a long title that dropped the store).
function productName(metaTitle: string): string {
  const i = metaTitle.indexOf(" · ");
  return i > 0 ? metaTitle.slice(0, i) : metaTitle;
}

// A canonical URL as a Google-style breadcrumb: no protocol, path split into
// crumbs. Relative canonicals (import-only shops with no storefront slug) simply
// render without a host.
function breadcrumbUrl(url: string): string {
  const parts = url.replace(/^https?:\/\//, "").split("/").filter(Boolean);
  if (parts.length === 0) return url;
  const [host, ...rest] = parts;
  return rest.length ? `${host} › ${rest.join(" › ")}` : host;
}

function optimizingLabel(count: number): string {
  if (count <= 0) return "Ready for your first page";
  return `Optimizing ${count} ${count === 1 ? "page" : "pages"}`;
}

// Shared by the initial mount and the Retry button, so a failed load and a
// successful retry both funnel through one place: cache and show the fresh
// payload on success, or flag the friendly error state on failure.
export async function loadSearchOverview(
  setData: (state: SearchOverviewVM) => void,
  setLoadError: (failed: boolean) => void,
  onError?: () => void,
): Promise<void> {
  try {
    const state = await fetchSearchOverview();
    cacheScreenData(SCREEN_CACHE_KEYS.search, state);
    setData(state);
    setLoadError(false);
  } catch {
    setLoadError(true);
    onError?.();
  }
}

// Shared by the AI-access Toggle and its own test: persists the one real
// choice on this screen, leaving the toast + refresh side effects to the
// caller so the same function drives the UI and is directly testable.
export async function saveAllowAiCrawlers(
  next: boolean,
  onSaved: () => void,
  onError: () => void,
): Promise<void> {
  try {
    await updateSettings({ allowAiCrawlers: next });
    onSaved();
  } catch {
    onError();
  }
}

export default function Search({ app }: { app: DashboardCtx }) {
  const { toast } = app;
  const [data, setData] = useState<SearchOverviewVM | null>(() =>
    cachedScreenData<SearchOverviewVM>(SCREEN_CACHE_KEYS.search),
  );
  const [loadError, setLoadError] = useState(false);
  const [savingCrawlers, setSavingCrawlers] = useState(false);
  // Seeded straight from the same cache read as `data` (not just the effect
  // below) so a cache hit paints the field on the very first render, matching
  // what renderToStaticMarkup produces server-side (effects never run there).
  const [description, setDescription] = useState(() => data?.settings.orgDescription ?? "");
  const [savingDescription, setSavingDescription] = useState(false);

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

  // Re-seed the editable field whenever fresh settings arrive (initial load or
  // a later refresh), so a stale value from an earlier mount never lingers.
  useEffect(() => {
    setDescription(data?.settings.orgDescription ?? "");
  }, [data?.settings.orgDescription]);

  function refresh() {
    // A background refresh (after a toggle/save) keeps the last-known data on
    // screen; surface a toast on failure so a merchant knows the values are stale.
    loadSearchOverview(setData, setLoadError, () =>
      toast("Couldn't refresh your Search settings. Reload to see the latest.", "warn", "critical"),
    );
  }

  async function onToggleCrawlers(next: boolean) {
    setSavingCrawlers(true);
    await saveAllowAiCrawlers(
      next,
      () => {
        toast(
          next ? "AI assistants can read your store." : "AI assistants asked not to read your store.",
          "check",
        );
        refresh();
      },
      () => toast("Could not update", "warn", "critical"),
    );
    setSavingCrawlers(false);
  }

  async function onSaveDescription() {
    setSavingDescription(true);
    try {
      await updateSettings({ orgDescription: description.trim() || null });
      toast("Saved.", "check");
      refresh();
    } catch {
      toast("Could not save", "warn", "critical");
    } finally {
      setSavingDescription(false);
    }
  }

  if (!data) {
    if (loadError) {
      return (
        <Placeholder
          icon="warn"
          title="We couldn't load your Search settings right now."
          actionLabel="Try again"
          onAction={refresh}
        />
      );
    }
    return <TableSkeleton />;
  }

  const { settings, preview } = data;
  const sample = preview.sample;

  return (
    <div className="cd-screen cd-seo">
      <header className="cd-seo__head">
        <div className="cd-seo__head-text">
          <h1 className="cd-seo__title">Search</h1>
        </div>
        <div className="cd-seo__live" role="status">
          <span className="cd-seo__live-dot" aria-hidden="true" />
          <span>{optimizingLabel(preview.productCount)}</span>
        </div>
      </header>

      <section className="cd-seo__section">
        <Card>
          {sample ? (
            <div className="cd-seo__panels">
              <div className="cd-seo__panel">
                <div className="cd-seo__panel-head">
                  <CDIcon name="search" size={15} strokeWidth={1.9} />
                  On Google
                </div>
                <div className="cd-serp">
                  <div className="cd-serp__url">{breadcrumbUrl(sample.url)}</div>
                  <div className="cd-serp__title">{sample.title}</div>
                  <div className="cd-serp__desc">{sample.description}</div>
                </div>
              </div>
              <div className="cd-seo__panel">
                <div className="cd-seo__panel-head">
                  <CDIcon name="assist" size={15} strokeWidth={1.9} />
                  On AI assistants
                </div>
                <div className="cd-seo__chat">
                  <div className="cd-seo__ask">Where can I buy {productName(sample.title)}?</div>
                  <div className="cd-seo__answer">
                    <span className="cd-seo__answer-store">{preview.storeName}</span> sells{" "}
                    {productName(sample.title)}.
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="cd-seo__empty">
              <span className="cd-seo__empty-ic">
                <CDIcon name="search" size={20} />
              </span>
              <div className="cd-seo__empty-title">
                Add a product and you&rsquo;ll see exactly how it appears here.
              </div>
              <p className="cd-seo__empty-sub">
                Every product page is written for Google and AI assistants the moment you publish it.
              </p>
            </div>
          )}
        </Card>
      </section>

      <section className="cd-seo__section">
        <h2 className="cd-seo__h2">Settings</h2>
        <Card pad={false}>
          <div className="cd-seo__set">
            <div className="cd-seo__row">
              <div className="cd-seo__info">
                <div className="cd-seo__label">Let AI assistants read my store</div>
              </div>
              <Toggle
                value={settings.allowAiCrawlers}
                onChange={onToggleCrawlers}
                disabled={savingCrawlers}
                ariaLabel="Let AI assistants read my store"
              />
            </div>
            <div className="cd-seo__row">
              <div className="cd-seo__info">
                <div className="cd-seo__label">Store description</div>
              </div>
              <div className="cd-seo__control">
                <div className="cd-seo__inputwrap">
                  <input
                    className="cd-input cd-seo__input"
                    value={description}
                    maxLength={DESCRIPTION_MAX}
                    onChange={(e) => setDescription(e.target.value)}
                    aria-label="Store description"
                  />
                  <span className="cd-seo__count" aria-hidden="true">
                    {description.length}/{DESCRIPTION_MAX}
                  </span>
                </div>
                <Btn kind="primary" small onClick={onSaveDescription} disabled={savingDescription}>
                  {savingDescription ? "Saving..." : "Save"}
                </Btn>
              </div>
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}
