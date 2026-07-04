// Shared shell for the standalone auth pages (/login, /signup, /reset, the
// verify screens). Renders the design-system card on the dashboard background;
// pages supply the form. Forms are plain document POSTs, so everything here
// must keep working with JS disabled; the pending/toggle state below is a
// hydration-only enhancement on top of that.
import { createContext, useContext, useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { authErrorMessage, AUTH_NOTICE_MESSAGES } from "~/lib/auth/messages";
import { CDIcon } from "~/components/dashboard/icons";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="cd-root cd-auth-root">
      <main className="cd-auth-wrap">
        <div className="cd-auth-card">
          <a className="cd-auth-brand" href="https://calderyncompany.com">
            <span className="cd-auth-brand-mark">
              <svg viewBox="0 0 32 32" fill="none" aria-hidden>
                <path d="M16 2 L28.12 9 L28.12 23 L16 30 L3.88 23 L3.88 9 Z" fill="var(--accent)" />
                <path
                  d="M24.4 11.15 L16 6.3 L7.6 11.15 L7.6 20.85 L16 25.7 L24.4 20.85"
                  stroke="var(--on-accent)"
                  strokeWidth="3.6"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            Calderyn
          </a>
          {children}
        </div>
      </main>
    </div>
  );
}

/** Error banner driven by an ?error= code; null when there is nothing to show. */
export function AuthError({ code }: { code: string | null }) {
  const message = authErrorMessage(code);
  if (!message) return null;
  return (
    <p className="cd-auth-banner cd-auth-banner--error" role="alert">
      {message}
    </p>
  );
}

/** Positive/informational banner driven by a notice key (reset, sent, signed_out). */
export function AuthNotice({ notice }: { notice: string | null }) {
  const message = notice ? AUTH_NOTICE_MESSAGES[notice] : null;
  if (!message) return null;
  return (
    <p className="cd-auth-banner cd-auth-banner--ok" role="status">
      {message}
    </p>
  );
}

const AuthPendingContext = createContext(false);

/**
 * Plain document-POST form with a submit latch: after the first submit the
 * enclosed AuthSubmit disables and swaps to its pending label, and a repeat
 * submit (double click, Enter re-fire) is suppressed. Without JS the latch
 * never engages and the form submits normally.
 */
export function AuthForm({
  action,
  children,
  style,
}: {
  action: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    // A back/forward-cache restore keeps component state; re-enable the form
    // so returning to the page never strands a disabled submit button.
    const onPageShow = () => setPending(false);
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);
  return (
    <form
      method="post"
      action={action}
      style={style}
      onSubmit={(event) => {
        if (pending) {
          event.preventDefault();
          return;
        }
        setPending(true);
      }}
    >
      <AuthPendingContext.Provider value={pending}>{children}</AuthPendingContext.Provider>
    </form>
  );
}

/** True while the enclosing AuthForm is submitting. Always false before hydration. */
export function useAuthFormPending(): boolean {
  return useContext(AuthPendingContext);
}

export function AuthSubmit({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const pending = useAuthFormPending();
  return (
    <button className="cd-auth-submit" type="submit" disabled={pending}>
      {pending ? pendingLabel : label}
    </button>
  );
}

/**
 * Password input with an inline show/hide toggle. The toggle is type="button"
 * so it can never submit the form; without JS it is inert and the field stays
 * a normal password input.
 */
export function PasswordField({
  id,
  name = "password",
  autoComplete,
  minLength,
  autoFocus,
}: {
  id: string;
  name?: string;
  autoComplete: string;
  minLength?: number;
  autoFocus?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="cd-auth-pwwrap">
      <input
        className="cd-auth-input"
        id={id}
        name={name}
        type={visible ? "text" : "password"}
        required
        minLength={minLength}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
      />
      <button
        type="button"
        className="cd-auth-pwtoggle"
        aria-label={visible ? "Hide password" : "Show password"}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? "Hide" : "Show"}
      </button>
    </div>
  );
}

export function ShopifyButton({
  label,
  returnTo,
  baseUrl,
}: {
  label: string;
  returnTo?: string | null;
  // Same host constraint as GoogleButton: the Shopify OAuth __Host- state
  // cookie and its redirect_uri live on the public apex, so the flow must
  // start there and not on this app.* origin, or the callback's state check
  // never sees the cookie. Empty in single-host dev.
  baseUrl?: string;
}) {
  const path = returnTo
    ? `/dashboard/login?return_to=${encodeURIComponent(returnTo)}`
    : "/dashboard/login";
  const href = `${baseUrl ?? ""}${path}`;
  return (
    <a className="cd-auth-google" href={href}>
      <CDIcon name="store" size={16} />
      {label}
    </a>
  );
}

export function GoogleButton({
  label,
  returnTo,
  baseUrl,
}: {
  label: string;
  returnTo?: string | null;
  // Absolute origin the Google flow must run on (the public apex where the
  // __Host- CSRF cookie and the Google-registered redirect_uri live). These
  // pages are served on app.*, so a bare relative path would set the state
  // cookie on the wrong host and the callback's state check would always fail.
  // Empty in single-host dev, where a relative path is already correct.
  baseUrl?: string;
}) {
  const path = returnTo
    ? `/dashboard/auth/google?return_to=${encodeURIComponent(returnTo)}`
    : "/dashboard/auth/google";
  const href = `${baseUrl ?? ""}${path}`;
  return (
    <a className="cd-auth-google" href={href}>
      <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
        <path
          fill="#EA4335"
          d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
        />
        <path
          fill="#4285F4"
          d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
        />
        <path
          fill="#FBBC05"
          d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
        />
        <path
          fill="#34A853"
          d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
        />
      </svg>
      {label}
    </a>
  );
}
