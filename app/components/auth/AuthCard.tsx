// Shared shell for the standalone auth pages (/login, /signup, /reset, the
// verify screens). Renders the design-system card on the dashboard background;
// pages supply the form. Server-rendered, no client state.
import type { ReactNode } from "react";
import { authErrorMessage, AUTH_NOTICE_MESSAGES } from "~/lib/auth/messages";
import { CDIcon } from "~/components/dashboard/icons";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="cd-root">
      <main className="cd-auth-wrap">
        <div className="cd-auth-card">
          <a className="cd-auth-brand" href="https://calderyncompany.com">
            <span className="cd-auth-brand-mark" aria-hidden>
              C
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

export function ShopifyButton({ label, returnTo }: { label: string; returnTo?: string | null }) {
  const href = returnTo
    ? `/dashboard/login?return_to=${encodeURIComponent(returnTo)}`
    : "/dashboard/login";
  return (
    <a className="cd-auth-google" href={href}>
      <CDIcon name="store" size={16} />
      {label}
    </a>
  );
}

export function GoogleButton({ label, returnTo }: { label: string; returnTo?: string | null }) {
  const href = returnTo
    ? `/dashboard/auth/google?return_to=${encodeURIComponent(returnTo)}`
    : "/dashboard/auth/google";
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
