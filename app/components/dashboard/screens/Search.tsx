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
  const [verifyCode, setVerifyCode] = useState(() => data?.settings.googleSiteVerification ?? "");
  const [savingVerify, setSavingVerify] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

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

  useEffect(() => {
    setVerifyCode(data?.settings.googleSiteVerification ?? "");
  }, [data?.settings.googleSiteVerification]);

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

  // Persist the Google verification token. Once saved, the storefront home serves
  // the matching <meta> tag so Google's ownership check passes on its next crawl.
  async function onSaveVerification() {
    setSavingVerify(true);
    try {
      await updateSettings({ googleSiteVerification: verifyCode.trim() || null });
      toast(verifyCode.trim() ? "Verification tag is live on your store." : "Verification tag removed.", "check");
      refresh();
    } catch {
      toast("Could not save", "warn", "critical");
    } finally {
      setSavingVerify(false);
    }
  }

  // Copy a link to the clipboard and flash "Copied" on the matching button
  // (keyed so only the button that was pressed changes label).
  async function copyLink(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((k) => (k === key ? null : k)), 1600);
    } catch {
      toast("Couldn't copy. Select the link and copy it manually.", "warn", "critical");
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
  // The store's public web address (the sitemap URL minus the filename) — this is
  // exactly what a merchant registers as their site in Google Search Console.
  const siteUrl = data.sitemapUrl ? data.sitemapUrl.replace(/\/sitemap\.xml$/, "") : null;

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

      <section className="cd-seo__section">
        <div className="cd-seo__head-text">
          <h2 className="cd-seo__h2">Get found on Google</h2>
          <p className="cd-seo__lede">
            Follow these five steps once, in order, and Google will start showing your store. It&rsquo;s free and takes
            about five minutes.
          </p>
        </div>
        <Card pad={false}>
          <div className="cd-seo__set">
            <div className="cd-seo__row">
              <div className="cd-seo__info">
                <div className="cd-seo__label">
                  <span className="cd-seo__step">1</span>Open Google Search Console
                </div>
                <div className="cd-seo__hint">
                  It opens in a new tab. If it asks you to sign in, use any Google account. If you&rsquo;re already
                  signed in, you&rsquo;ll go straight in.
                </div>
              </div>
              <div className="cd-seo__control">
                <a
                  className="cd-btn cd-btn-primary cd-btn-sm"
                  href="https://search.google.com/search-console/welcome"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <CDIcon name="external" size={14} strokeWidth={1.9} />
                  Open Google
                </a>
              </div>
            </div>

            <div className="cd-seo__row">
              <div className="cd-seo__info">
                <div className="cd-seo__label">
                  <span className="cd-seo__step">2</span>Enter your store address
                </div>
                <div className="cd-seo__hint">
                  Google asks how to find your site. Click the box labelled <b>URL prefix</b>, paste the address below,
                  then click <b>Continue</b>.
                </div>
              </div>
              <div className="cd-seo__control">
                {siteUrl ? (
                  <>
                    <code className="cd-seo__url">{siteUrl}</code>
                    <Btn kind="secondary" small onClick={() => copyLink(siteUrl, "site")}>
                      {copied === "site" ? "Copied" : "Copy"}
                    </Btn>
                  </>
                ) : (
                  <span className="cd-seo__hint">Publish your storefront first to get your address.</span>
                )}
              </div>
            </div>

            <div className="cd-seo__row">
              <div className="cd-seo__info">
                <div className="cd-seo__label">
                  <span className="cd-seo__step">3</span>Choose &ldquo;HTML tag&rdquo; and copy the whole line
                </div>
                <div className="cd-seo__hint">
                  Google shows a few ways to prove it&rsquo;s your store. Click <b>HTML tag</b>, then copy the whole
                  line of code it shows. You don&rsquo;t need to trim it.
                </div>
              </div>
            </div>

            <div className="cd-seo__row">
              <div className="cd-seo__info">
                <div className="cd-seo__label">
                  <span className="cd-seo__step">4</span>Paste the code here, then verify
                </div>
                <div className="cd-seo__hint">
                  Paste what you copied below and click Save. The whole tag or just the code both work; Calderyn sorts
                  it out and adds it to your store. Then go back to Google and click its blue <b>Verify</b> button.
                </div>
              </div>
              <div className="cd-seo__control">
                <div className="cd-seo__inputwrap">
                  <input
                    className="cd-input cd-seo__tinput"
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value)}
                    placeholder="Paste code here"
                    aria-label="Google verification code"
                  />
                </div>
                <Btn kind="primary" small onClick={onSaveVerification} disabled={savingVerify}>
                  {savingVerify ? "Saving..." : "Save"}
                </Btn>
              </div>
            </div>

            {settings.googleSiteVerification ? (
              <div className="cd-seo__row cd-seo__row--slim">
                <span className="cd-seo__ok">
                  <CDIcon name="check" size={14} strokeWidth={2} />
                  Saved and live on your store. Now click <b>Verify</b> back in Google.
                </span>
              </div>
            ) : null}

            <div className="cd-seo__row">
              <div className="cd-seo__info">
                <div className="cd-seo__label">
                  <span className="cd-seo__step">5</span>Hand Google your page list
                </div>
                <div className="cd-seo__hint">
                  Once verified, open <b>Sitemaps</b> in Google&rsquo;s left menu, paste the link below, and click
                  <b> Submit</b>. That&rsquo;s your whole store in one link.
                </div>
              </div>
              <div className="cd-seo__control">
                {data.sitemapUrl ? (
                  <>
                    <code className="cd-seo__url">{data.sitemapUrl}</code>
                    <Btn kind="secondary" small onClick={() => copyLink(data.sitemapUrl!, "sitemap")}>
                      {copied === "sitemap" ? "Copied" : "Copy"}
                    </Btn>
                  </>
                ) : (
                  <span className="cd-seo__hint">Publish your storefront first to get this link.</span>
                )}
              </div>
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}
