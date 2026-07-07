// Search - the merchant SEO/AIO surface. Every storefront page is already
// optimized live (the engine writes meta + structured data on each render), so
// this screen is a confirmation, not a control panel: it states that fact, then
// exposes the one real choice a merchant has (letting AI assistants read the
// store) plus an optional store description. Seeds from the screen cache for
// instant paint, then refetches.
import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Card, Btn, Toggle, Placeholder, TableSkeleton } from "../ui";
import { CDIcon } from "../icons";
import { cachedScreenData, cacheScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import { fetchSearchSettings, updateSettings, type SeoSettings } from "~/lib/dashboard/search-client";

// Store-description hard cap: mirrors the server's own bound (see
// dashboard.api.search.tsx), so a save can never be rejected for length.
const DESCRIPTION_MAX = 200;

// Shared by the initial mount and the Retry button, so a failed load and a
// successful retry both funnel through one place: cache and show the fresh
// settings on success, or flag the friendly error state on failure.
export async function loadSearchSettings(
  setData: (state: SeoSettings) => void,
  setLoadError: (failed: boolean) => void,
  onError?: () => void,
): Promise<void> {
  try {
    const state = await fetchSearchSettings();
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
  const [data, setData] = useState<SeoSettings | null>(() =>
    cachedScreenData<SeoSettings>(SCREEN_CACHE_KEYS.search),
  );
  const [loadError, setLoadError] = useState(false);
  const [savingCrawlers, setSavingCrawlers] = useState(false);
  // Seeded straight from the same cache read as `data` (not just the effect
  // below) so a cache hit paints the field on the very first render, matching
  // what renderToStaticMarkup produces server-side (effects never run there).
  const [description, setDescription] = useState(() => data?.orgDescription ?? "");
  const [savingDescription, setSavingDescription] = useState(false);

  useEffect(() => {
    let live = true;
    loadSearchSettings(
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
    setDescription(data?.orgDescription ?? "");
  }, [data?.orgDescription]);

  function refresh() {
    // A background refresh (after a toggle/save) keeps the last-known data on
    // screen; surface a toast on failure so a merchant knows the values are stale.
    loadSearchSettings(setData, setLoadError, () =>
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

  return (
    <div className="cd-screen cd-seo">
      <header className="cd-seo__head">
        <div className="cd-seo__head-text">
          <h1 className="cd-seo__title">Search</h1>
          <p className="cd-seo__lede">How your store looks to Google and AI assistants.</p>
        </div>
      </header>

      <Card>
        <div className="cd-seo__status">
          <span className="cd-seo__status-ic">
            <CDIcon name="check" size={18} strokeWidth={2.2} />
          </span>
          <div>
            <div className="cd-seo__status-title">Your store is optimized, automatically.</div>
            <p className="cd-seo__status-sub">
              Every product page is written for Google and AI assistants the moment you publish it.
              There is nothing to set up.
            </p>
          </div>
        </div>
      </Card>

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
            value={data.allowAiCrawlers}
            onChange={onToggleCrawlers}
            disabled={savingCrawlers}
            ariaLabel="Let AI assistants read and cite my store"
          />
        </div>
      </Card>

      <Card>
        <div className="cd-seo__form">
          <label className="cd-field">
            <span>How your store is described to Google (optional)</span>
            <input
              className="cd-input"
              value={description}
              maxLength={DESCRIPTION_MAX}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div>
            <Btn kind="primary" small onClick={onSaveDescription} disabled={savingDescription}>
              {savingDescription ? "Saving..." : "Save"}
            </Btn>
          </div>
        </div>
      </Card>
    </div>
  );
}
