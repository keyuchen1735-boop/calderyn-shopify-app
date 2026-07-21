// Error surfaces for the dashboard subtree and the root-level backstop.
//
// The dashboard SPA renders entirely client-side off polled API data; before
// this, a single render throw (e.g. a partial row reaching `.toFixed`) had no
// boundary to catch it and fell through to Remix's bare "Application error".
// This catches such errors and shows a recoverable fallback instead.
//
// The fallback is self-contained on purpose: inline style attributes only, no
// `cd-*` classes and no <style> element. It doubles as the root-level backstop
// (before the dashboard stylesheet loads) and must render on surfaces whose
// CSP allows style attributes but not un-nonced <style> elements
// (app/lib/storefront-runtime/csp.server.ts). Theming uses CSS light-dark()
// against the element's color-scheme so both modes work from one declaration.

import {
  Component,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { isRouteErrorResponse } from "@remix-run/react";

import { CalderynHexMark } from "~/components/CalderynHexMark";

// Mirrors the dashboard theme tokens in app/styles/dashboard.css (.cd-root /
// .cd-root.cd-dark). Kept inline because this component cannot assume that
// stylesheet is loaded.
const TONE = {
  bg: "light-dark(#f5f5f7, #1c1c1e)",
  card: "light-dark(#ffffff, #2c2c2e)",
  border: "light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.08))",
  ink: "light-dark(#1d1d1f, #f5f5f7)",
  muted: "light-dark(#6e6e73, #98989f)",
  faint: "light-dark(#aeaeb2, #636366)",
  accent: "light-dark(#1a1a1c, #f2f2f4)",
  onAccent: "light-dark(#ffffff, #16161a)",
  grayBg: "light-dark(rgba(120, 120, 128, 0.08), rgba(120, 120, 128, 0.18))",
  grayBgHover:
    "light-dark(rgba(120, 120, 128, 0.14), rgba(120, 120, 128, 0.26))",
  shadow:
    "0 12px 32px -10px light-dark(rgba(0, 0, 0, 0.14), rgba(0, 0, 0, 0.55))",
};

const FONT_STACK =
  "Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

const NIGHT_MODE_KEY = "cd-night-mode";
const STALE_RELOAD_KEY = "cd-stale-reload-at";
const STALE_RELOAD_WINDOW_MS = 60_000;

// A failed fetch of a hashed build asset after a deploy replaced it. The most
// common source of "random" error pages: prod autodeploys main, and any tab
// left open across a deploy holds references to chunk URLs that no longer
// exist. Message shapes cover Chromium, Firefox, Safari, and webpack-style
// wording so the detector keeps working if the bundler changes.
const STALE_CHUNK_RE =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|loading chunk [\w-]+ failed|chunkloaderror|css chunk load failed/i;

export function isStaleChunkError(error: unknown): boolean {
  if (error instanceof Error) {
    return STALE_CHUNK_RE.test(`${error.name}: ${error.message}`);
  }
  return typeof error === "string" && STALE_CHUNK_RE.test(error);
}

// Reload once per minute at most: enough to transparently recover from a
// deploy, while a real (non-deploy) failure cannot spin the tab in a reload
// loop. When sessionStorage is unavailable there is no loop guard, so no
// automatic reload happens at all.
export function autoReloadForStaleDeploy(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const last = Number(window.sessionStorage.getItem(STALE_RELOAD_KEY) ?? "0");
    if (Date.now() - last < STALE_RELOAD_WINDOW_MS) return false;
    window.sessionStorage.setItem(STALE_RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

type Variant = "not-found" | "stale-deploy" | "crash";

function variantFor(error: unknown): Variant {
  if (isRouteErrorResponse(error) && error.status === 404) return "not-found";
  if (isStaleChunkError(error)) return "stale-deploy";
  return "crash";
}

// The <title> for full-document error pages (root.tsx backstop).
export function errorPageTitle(error: unknown): string {
  return variantFor(error) === "not-found"
    ? "Page not found"
    : "Something went wrong";
}

type Scheme = "light dark" | "light" | "dark";

// Dashboard pages follow the merchant's night-mode toggle (dark by default);
// everything else follows the system preference.
function preferredScheme(): Scheme {
  if (typeof window === "undefined") return "light dark";
  if (window.location.pathname.startsWith("/dashboard")) {
    try {
      return window.localStorage.getItem(NIGHT_MODE_KEY) === "0"
        ? "light"
        : "dark";
    } catch {
      return "dark";
    }
  }
  return "light dark";
}

function goHome() {
  if (typeof window === "undefined") return;
  window.location.assign(
    window.location.pathname.startsWith("/dashboard") ? "/dashboard" : "/",
  );
}

function reloadPage() {
  if (typeof window !== "undefined") window.location.reload();
}

const buttonBase: CSSProperties = {
  appearance: "none",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 13.5,
  fontWeight: 550,
  letterSpacing: "-0.008em",
  lineHeight: 1.2,
  padding: "9px 18px",
  borderRadius: 999,
  transition: "opacity 0.15s ease, background 0.15s ease, transform 0.12s ease",
};

function FallbackButton({
  label,
  onClick,
  primary,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  // rest() also clears the pressed transform so a press-drag-release off the
  // button cannot leave it stuck at the pressed scale.
  const rest = (): Record<string, string> =>
    primary
      ? { opacity: "1", transform: "none" }
      : { background: TONE.grayBg, transform: "none" };
  const hover = (): Record<string, string> =>
    primary ? { opacity: "0.88" } : { background: TONE.grayBgHover };
  const apply = (el: HTMLButtonElement, s: Record<string, string>) =>
    Object.assign(el.style, s);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={(e) => apply(e.currentTarget, hover())}
      onMouseLeave={(e) => apply(e.currentTarget, rest())}
      onFocus={(e) => apply(e.currentTarget, hover())}
      onBlur={(e) => apply(e.currentTarget, rest())}
      onPointerDown={(e) =>
        apply(e.currentTarget, { transform: "scale(0.97)" })
      }
      onPointerUp={(e) => apply(e.currentTarget, { transform: "none" })}
      onPointerLeave={(e) => apply(e.currentTarget, rest())}
      style={
        primary
          ? { ...buttonBase, background: TONE.accent, color: TONE.onAccent }
          : { ...buttonBase, background: TONE.grayBg, color: TONE.accent }
      }
    >
      {label}
    </button>
  );
}

const VARIANT_COPY: Record<Variant, { title: string; body: string }> = {
  crash: {
    title: "Something went wrong",
    body: "This screen hit a snag. Your store and your data are safe.",
  },
  "stale-deploy": {
    title: "A quick refresh is needed",
    body: "Calderyn was updated while this page was open. Refresh to pick up the new version.",
  },
  "not-found": {
    title: "Page not found",
    body: "This page does not exist or may have moved.",
  },
};

export function DashboardErrorFallback({
  error,
  onRetry,
  instant,
}: {
  error?: unknown;
  /** Recover in place (remount the crashed subtree) instead of a full reload. */
  onRetry?: () => void;
  /**
   * Resolve the theme synchronously. Only safe for pure client renders (the
   * class boundary); server-rendered route boundaries must leave this off so
   * hydration markup matches, and the effect below settles the theme instead.
   */
  instant?: boolean;
}) {
  const variant = variantFor(error);
  const copy = VARIANT_COPY[variant];
  const cardRef = useRef<HTMLDivElement>(null);
  const [scheme, setScheme] = useState<Scheme>(() =>
    instant ? preferredScheme() : "light dark",
  );

  useEffect(() => {
    setScheme(preferredScheme());
  }, []);

  // A stale-chunk crash usually needs no user action at all: reload once,
  // transparently, and the new deploy loads. The card below only lingers when
  // the guard says a reload already happened recently (so something else is
  // wrong) or sessionStorage is unavailable.
  useEffect(() => {
    if (variant === "stale-deploy") autoReloadForStaleDeploy();
  }, [variant]);

  useEffect(() => {
    const node = cardRef.current;
    if (!node || typeof node.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    node.animate(
      [
        { opacity: 0, transform: "translateY(10px) scale(0.99)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 360, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
  }, []);

  // Only surface raw error text in development. In production this backstop
  // covers every route (incl. public storefront), so a future unsanitized
  // server message must never render to end users.
  const detail =
    import.meta.env?.DEV && error instanceof Error && error.message
      ? error.message
      : undefined;

  return (
    <div
      role="alert"
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: TONE.bg,
        color: TONE.ink,
        colorScheme: scheme,
        fontFamily: FONT_STACK,
      }}
    >
      <div
        ref={cardRef}
        style={{
          width: "100%",
          maxWidth: 420,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
          padding: "34px 30px 30px",
          textAlign: "center",
          background: TONE.card,
          border: `1px solid ${TONE.border}`,
          borderRadius: 16,
          boxShadow: TONE.shadow,
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: 52,
            height: 52,
            display: "grid",
            placeItems: "center",
            borderRadius: 14,
            background: TONE.grayBg,
            marginBottom: 4,
          }}
        >
          <CalderynHexMark size={26} />
        </div>
        <h1
          style={{
            margin: 0,
            fontSize: 17,
            fontWeight: 600,
            letterSpacing: "-0.015em",
          }}
        >
          {copy.title}
        </h1>
        <p
          style={{
            margin: 0,
            maxWidth: "40ch",
            fontSize: 14,
            lineHeight: 1.5,
            color: TONE.muted,
          }}
        >
          {copy.body}
        </p>
        {detail ? (
          <code
            style={{
              fontSize: 12,
              color: TONE.faint,
              maxWidth: 360,
              wordBreak: "break-word",
            }}
          >
            {detail}
          </code>
        ) : null}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: 10,
            marginTop: 12,
          }}
        >
          {variant === "crash" ? (
            <>
              {onRetry ? (
                <FallbackButton label="Try again" onClick={onRetry} primary />
              ) : (
                <FallbackButton label="Reload" onClick={reloadPage} primary />
              )}
              <FallbackButton label="Back to home" onClick={goHome} />
            </>
          ) : null}
          {variant === "stale-deploy" ? (
            <FallbackButton label="Refresh" onClick={reloadPage} primary />
          ) : null}
          {variant === "not-found" ? (
            <FallbackButton label="Back to home" onClick={goHome} primary />
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface Props {
  children?: ReactNode;
}
interface State {
  error: Error | null;
}

// Offer in-place retry only when the previous retry did not just fail again;
// a deterministic crash (same bad data every render) falls back to Reload.
const RETRY_COOLDOWN_MS = 10_000;

export class DashboardErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  private lastRetryAt = 0;

  componentDidMount() {
    // The dashboard is a self-driven SPA whose back/forward handler lives inside
    // DashboardApp — which this boundary unmounts the instant it shows the
    // fallback. So once an error is caught, popstate no longer reaches the SPA
    // and the fallback would stick until a full reload. Listen here too and drop
    // the caught error on navigation, remounting the subtree fresh (it re-derives
    // the screen from the URL and refetches) so back/forward recovers in place.
    if (typeof window !== "undefined") {
      window.addEventListener("popstate", this.handlePopState);
    }
  }

  componentWillUnmount() {
    if (typeof window !== "undefined") {
      window.removeEventListener("popstate", this.handlePopState);
    }
  }

  handlePopState = () => {
    if (this.state.error) this.setState({ error: null });
  };

  handleRetry = () => {
    this.lastRetryAt = Date.now();
    this.setState({ error: null });
  };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The SPA otherwise swallows render errors; surface them for prod debugging.
    console.error("Dashboard render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      const retryable = Date.now() - this.lastRetryAt > RETRY_COOLDOWN_MS;
      return (
        <DashboardErrorFallback
          error={this.state.error}
          onRetry={retryable ? this.handleRetry : undefined}
          instant
        />
      );
    }
    return this.props.children;
  }
}
