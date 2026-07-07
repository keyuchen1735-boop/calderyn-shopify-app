// Preferences - the merchant SEO/AIO surface (Store > Preferences). Every
// storefront page is already written for search + AI the moment it publishes;
// this screen is just the two switches a merchant actually controls: whether
// search engines and AI assistants may read the store, plus an optional store
// description. Seeds from the screen cache for instant paint, then refetches.
import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Card, Btn, Toggle, Tooltip, Placeholder, TableSkeleton } from "../ui";
import { CDIcon } from "../icons";
import { cachedScreenData, cacheScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import { fetchSearchOverview, updateSettings, suggestDescription, type SearchOverviewVM } from "~/lib/dashboard/search-client";

// Store-description hard cap: mirrors the server's own bound (see
// dashboard.api.search.tsx), so a save can never be rejected for length.
const DESCRIPTION_MAX = 200;

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

// Shared by a settings Toggle and its own test: persists one boolean setting,
// leaving the toast + refresh side effects to the caller so the same function
// drives the UI and is directly testable.
export async function saveSetting(
  patch: { allowSearchEngines: boolean } | { allowAiCrawlers: boolean },
  onSaved: () => void,
  onError: () => void,
): Promise<void> {
  try {
    await updateSettings(patch);
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
  const [savingSearch, setSavingSearch] = useState(false);
  const [savingCrawlers, setSavingCrawlers] = useState(false);
  // Seeded straight from the same cache read as `data` (not just the effect
  // below) so a cache hit paints the field on the very first render, matching
  // what renderToStaticMarkup produces server-side (effects never run there).
  const [description, setDescription] = useState(() => data?.settings.orgDescription ?? "");
  const [savingDescription, setSavingDescription] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

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

  async function onToggleSearch(next: boolean) {
    setSavingSearch(true);
    await saveSetting(
      { allowSearchEngines: next },
      () => {
        toast(
          next ? "Search engines can find your store." : "Search engines asked not to list your store.",
          "check",
        );
        refresh();
      },
      () => toast("Could not update", "warn", "critical"),
    );
    setSavingSearch(false);
  }

  async function onToggleCrawlers(next: boolean) {
    setSavingCrawlers(true);
    await saveSetting(
      { allowAiCrawlers: next },
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

  // Draft a description from the store's own catalog + identity and drop it into
  // the field for review. It is not saved until the merchant clicks Save.
  async function onSuggestDescription() {
    setSuggesting(true);
    try {
      const { description: draft } = await suggestDescription();
      setDescription(draft);
    } catch {
      toast("Couldn't write one just now. Try again.", "warn", "critical");
    } finally {
      setSuggesting(false);
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

  const { settings } = data;

  return (
    <div className="cd-screen cd-seo">
      <header className="cd-seo__head">
        <div className="cd-seo__head-text">
          <h1 className="cd-seo__title">Preferences</h1>
          <p className="cd-seo__lede">Your products are optimized automatically. Choose who can find your store.</p>
        </div>
      </header>

      <section className="cd-seo__section">
        <Card pad={false}>
          <div className="cd-seo__set">
            <div className="cd-seo__row">
              <div className="cd-seo__info">
                <div className="cd-seo__label">Search engines (SEO)</div>
                <div className="cd-seo__hint">So people find your store on Google.</div>
              </div>
              <Toggle
                value={settings.allowSearchEngines}
                onChange={onToggleSearch}
                disabled={savingSearch}
                ariaLabel="Let search engines find my store"
              />
            </div>
            <div className="cd-seo__row">
              <div className="cd-seo__info">
                <div className="cd-seo__label">AI assistants (AIO)</div>
                <div className="cd-seo__hint">So ChatGPT and Perplexity can recommend your store.</div>
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
                <div className="cd-seo__hint">One line about your store, used in search and AI answers.</div>
              </div>
              <div className="cd-seo__control">
                <div className="cd-seo__inputwrap">
                  <span className="cd-seo__ai-slot">
                    <Tooltip content="Let Calderyn write one, tuned for Google and AI assistants.">
                      <button
                        type="button"
                        className="cd-seo__ai"
                        onClick={onSuggestDescription}
                        disabled={suggesting}
                        aria-label="Let Calderyn write a store description tuned for Google and AI assistants"
                        aria-busy={suggesting}
                      >
                        <CDIcon name="sparkle" size={13} strokeWidth={1.9} />
                      </button>
                    </Tooltip>
                  </span>
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
