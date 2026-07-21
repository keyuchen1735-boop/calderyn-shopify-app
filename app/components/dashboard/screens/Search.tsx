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
import { fetchSearchOverview, updateSettings, suggestDescription, disconnectGsc, type SearchOverviewVM } from "~/lib/dashboard/search-client";

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
  patch: { allowSearchEngines: boolean } | { allowAiCrawlers: boolean } | { weatherMerchandising: boolean },
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
  const [savingWeather, setSavingWeather] = useState(false);
  // Seeded straight from the same cache read as `data` (not just the effect
  // below) so a cache hit paints the field on the very first render, matching
  // what renderToStaticMarkup produces server-side (effects never run there).
  const [description, setDescription] = useState(() => data?.settings.orgDescription ?? "");
  const [savingDescription, setSavingDescription] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [verifyCode, setVerifyCode] = useState(() => data?.settings.googleSiteVerification ?? "");
  const [savingVerify, setSavingVerify] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [disconnectingGoogle, setDisconnectingGoogle] = useState(false);

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

  // One-shot post-connect notice: the Google OAuth callback lands the browser
  // back here with ?search=google-connected|google-error. Toast it once, strip
  // the marker so a reload/back-nav never re-announces it, and (on success)
  // refresh so the newly-connected card doesn't wait for the next poll.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const notice = params.get("search");
    if (notice !== "google-connected" && notice !== "google-error") return;
    params.delete("search");
    params.delete("reason");
    const qs = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
    );
    if (notice === "google-connected") {
      toast("Google connected. Results will start showing up here soon.", "check");
      refresh();
    } else {
      toast("Couldn't connect Google. Try again from the button below.", "warn", "critical");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onDisconnectGoogle() {
    setDisconnectingGoogle(true);
    try {
      await disconnectGsc();
      toast("Google disconnected.", "check");
      refresh();
    } catch {
      toast("Could not disconnect", "warn", "critical");
    } finally {
      setDisconnectingGoogle(false);
    }
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

  async function onToggleWeather(next: boolean) {
    setSavingWeather(true);
    await saveSetting(
      { weatherMerchandising: next },
      () => {
        toast(next ? "Weather-aware shop is on." : "Weather-aware shop is off.", "check");
        refresh();
      },
      () => toast("Could not update", "warn", "critical"),
    );
    setSavingWeather(false);
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
  // Deep link straight to this property's Sitemaps page in Search Console, so a
  // merchant who closed the tab can jump back. resource_id is the URL-prefix
  // property (the site address with a trailing slash), url-encoded.
  const sitemapsConsoleUrl = siteUrl
    ? `https://search.google.com/search-console/sitemaps?resource_id=${encodeURIComponent(`${siteUrl}/`)}`
    : null;

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
                <div className="cd-seo__label">Weather-aware shop</div>
                <div className="cd-seo__hint">
                  Float weather-relevant products to the top of your collections for each shopper, based on their own
                  local forecast (rain gear before a storm, summer goods on a sunny day).
                </div>
              </div>
              <Toggle
                value={settings.weatherMerchandising}
                onChange={onToggleWeather}
                disabled={savingWeather}
                ariaLabel="Turn on weather-aware product ordering"
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
          <p className="cd-seo__lede">Do this once and Google starts showing your store. Free, about 5 minutes.</p>
        </div>
        <Card pad={false}>
          <div className="cd-seo__set">
            <div className="cd-seo__row">
              <div className="cd-seo__info">
                <div className="cd-seo__label">
                  <span className="cd-seo__step">1</span>Open Google Search Console
                </div>
                <div className="cd-seo__hint">Opens in a new tab. Sign in with a Google account if it asks.</div>
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
                  Click <b>URL prefix</b>, paste your store address, then <b>Continue</b>.
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
                  <span className="cd-seo__step">3</span>Choose &ldquo;HTML tag&rdquo; and copy it
                </div>
                <div className="cd-seo__hint">
                  Click <b>HTML tag</b>, then copy the whole line of code Google shows.
                </div>
              </div>
            </div>

            <div className="cd-seo__row">
              <div className="cd-seo__info">
                <div className="cd-seo__label">
                  <span className="cd-seo__step">4</span>Paste the code, then verify
                </div>
                <div className="cd-seo__hint">
                  Paste it, click Save, then click <b>Verify</b> back in Google.
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
                  Saved and live. Now click <b>Verify</b> in Google.
                </span>
              </div>
            ) : null}

            <div className="cd-seo__row">
              <div className="cd-seo__info">
                <div className="cd-seo__label">
                  <span className="cd-seo__step">5</span>Hand Google your page list
                </div>
                <div className="cd-seo__hint">
                  Once verified, open{" "}
                  {sitemapsConsoleUrl ? (
                    <a className="cd-seo__link" href={sitemapsConsoleUrl} target="_blank" rel="noopener noreferrer">
                      Sitemaps
                    </a>
                  ) : (
                    <b>Sitemaps</b>
                  )}
                  . Your store address is already filled in, so just type this in the box and <b>Submit</b>.
                </div>
              </div>
              <div className="cd-seo__control">
                {data.sitemapUrl ? (
                  <>
                    <code className="cd-seo__url">sitemap.xml</code>
                    <Btn kind="secondary" small onClick={() => copyLink("sitemap.xml", "sitemap")}>
                      {copied === "sitemap" ? "Copied" : "Copy"}
                    </Btn>
                  </>
                ) : (
                  <span className="cd-seo__hint">Publish your storefront first to enable this.</span>
                )}
              </div>
            </div>
          </div>
        </Card>
      </section>

      <section className="cd-seo__section">
        <div className="cd-seo__head-text">
          <h2 className="cd-seo__h2">Google results</h2>
          <p className="cd-seo__lede">See how your store shows up on Google and catch pages that slip.</p>
        </div>
        <Card pad={false}>
          {data.google.connected ? (
            <div className="cd-seo__set">
              <div className="cd-seo__row">
                <div className="cd-stat-grid cd-seo__google-stats">
                  <div className="cd-stat">
                    <span className="cd-stat-label">Clicks to your store</span>
                    <span className="cd-stat-value tabular-nums">{data.google.clicks.toLocaleString()}</span>
                  </div>
                  <div className="cd-stat">
                    <span className="cd-stat-label">Times shown on Google</span>
                    <span className="cd-stat-value tabular-nums">{data.google.impressions.toLocaleString()}</span>
                  </div>
                </div>
              </div>

              {data.google.topQueries.length > 0 ? (
                <div className="cd-seo__row cd-seo__row--col">
                  <div className="cd-seo__info">
                    <div className="cd-seo__label">What people search</div>
                  </div>
                  <ul className="cd-seo__querylist">
                    {data.google.topQueries.slice(0, 5).map((q) => (
                      <li key={q.query} className="cd-seo__queryrow">
                        <span className="cd-seo__qname">{q.query}</span>
                        <span className="cd-seo__qmeta">
                          {q.clicks} clicks &middot; average spot on Google #{Math.round(q.position)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {data.google.slipping.length > 0 ? (
                <div className="cd-seo__row cd-seo__row--col">
                  <div className="cd-seo__info">
                    <div className="cd-seo__label">Needs a look</div>
                    <div className="cd-seo__hint">Pages losing ground on Google for these searches.</div>
                  </div>
                  <ul className="cd-seo__querylist">
                    {data.google.slipping.slice(0, 5).map((s) => (
                      <li key={`${s.pageUrl}:${s.query}`} className="cd-seo__queryrow">
                        <span className="cd-seo__qname">{s.query}</span>
                        <span className="cd-seo__qmeta cd-seo__qmeta--slip">
                          was #{Math.round(s.prevPosition)}, now #{Math.round(s.position)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="cd-seo__row cd-seo__row--slim">
                <span className="cd-seo__hint">
                  {data.google.lastCapturedDate
                    ? `Google data through ${data.google.lastCapturedDate}`
                    : "Google data is still coming in. Check back soon."}
                </span>
                <button
                  type="button"
                  className="cd-seo__quiet-btn"
                  onClick={onDisconnectGoogle}
                  disabled={disconnectingGoogle}
                >
                  {disconnectingGoogle ? "Disconnecting..." : "Disconnect"}
                </button>
              </div>
            </div>
          ) : (
            <div className="cd-seo__row">
              <div className="cd-seo__info">
                <div className="cd-seo__label">Not connected</div>
                <div className="cd-seo__hint">Connect your Google account to start tracking results.</div>
              </div>
              <div className="cd-seo__control">
                <Btn kind="primary" small onClick={() => { window.location.href = "/dashboard/auth/gsc"; }}>
                  Connect Google
                </Btn>
              </div>
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
