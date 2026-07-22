// app/routes/login.tsx
// The sign-in page for the Calderyn dashboard, served on the app origin
// (app.calderyncompany.com/login). The form posts to /dashboard/signin, which
// owns credentials, rate limits, and session minting; this page owns the UI
// and the friendly error states (?error= codes set by that action). When the
// device has remembered accounts (see lib/auth/remembered-accounts.server),
// they render as one-click cards above the credential form.
import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import dashboard from "~/styles/dashboard.css?url";
import {
  AuthShell,
  AuthError,
  AuthNotice,
  AuthForm,
  AuthSubmit,
  PasswordField,
  GoogleButton,
  ShopifyButton,
} from "~/components/auth/AuthCard";
import { CDIcon } from "~/components/dashboard/icons";
import { safeDashboardReturnTo, publicBaseUrl } from "~/lib/dashboard/http.server";
import { getSessionFromRequest } from "~/lib/dashboard/session.server";
import {
  resolveRememberedAccounts,
  type RememberedAccount,
} from "~/lib/auth/remembered-accounts.server";

export const meta: MetaFunction = () => [{ title: "Sign in — Calderyn" }];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboard }];

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  // Already signed in? Straight to where they were headed — a post-OAuth
  // connector bounce carries the destination (and its one-shot connect notice)
  // in ?return_to=, and dropping it would strand the merchant on the bare
  // dashboard with no confirmation.
  const session = await getSessionFromRequest(request);
  if (session) {
    return redirect(safeDashboardReturnTo(url.searchParams.get("return_to")) ?? "/dashboard");
  }

  // Accounts previously signed in on this device, resolved server-side (email
  // + store name come from the live session rows, never from the cookie).
  // Dead entries are pruned via the rewrite header. Resolution is best-effort:
  // a DB hiccup must not take down the sign-in page itself.
  let accounts: RememberedAccount[] = [];
  let accountsCookie: string | null = null;
  try {
    ({ accounts, cookieHeader: accountsCookie } = await resolveRememberedAccounts(request));
  } catch (err) {
    console.error("[login] remembered-accounts resolve failed", err);
  }

  return json(
    {
      error: url.searchParams.get("error"),
      notice: url.searchParams.get("notice"),
      email: url.searchParams.get("email") ?? "",
      // Validated here AND at the action; a hostile value never reaches the form.
      returnTo: safeDashboardReturnTo(url.searchParams.get("return_to")),
      // OAuth provider flows must start on the public apex (their callback host),
      // not this app.* origin — see GoogleButton / ShopifyButton.
      authBase: publicBaseUrl(),
      accounts,
    },
    accountsCookie ? { headers: { "Set-Cookie": accountsCookie } } : undefined,
  );
}

function AccountChooser({
  accounts,
  returnTo,
}: {
  accounts: RememberedAccount[];
  returnTo: string | null;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!listRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const cards = listRef.current.querySelectorAll(".cd-auth-account");
    const tween = gsap.from(cards, {
      opacity: 0,
      y: 10,
      duration: 0.4,
      ease: "power2.out",
      stagger: 0.06,
      clearProps: "all",
    });
    return () => {
      tween.kill();
    };
  }, []);

  return (
    <div className="cd-auth-accounts" ref={listRef}>
      {accounts.map((a) => {
        const subtitle = a.email ?? a.storeDomain;
        return (
          <div className="cd-auth-account" key={a.sid}>
            <form method="post" action="/dashboard/api/switch-account" className="cd-auth-account-form">
              <input type="hidden" name="sid" value={a.sid} />
              {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}
              <button type="submit" className="cd-auth-account-btn">
                <span className="cd-auth-account-avatar" aria-hidden>
                  {(a.storeName || "C").slice(0, 1).toUpperCase()}
                </span>
                <span className="cd-auth-account-meta">
                  <span className="cd-auth-account-store">{a.storeName}</span>
                  {subtitle ? <span className="cd-auth-account-email">{subtitle}</span> : null}
                </span>
                <CDIcon name="chevronRight" size={16} />
              </button>
            </form>
            <form method="post" action="/dashboard/api/switch-account">
              <input type="hidden" name="sid" value={a.sid} />
              <input type="hidden" name="intent" value="remove" />
              {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}
              <button
                type="submit"
                className="cd-auth-account-remove"
                aria-label={`Remove ${a.storeName} from this device`}
                title="Remove from this device"
              >
                <CDIcon name="x" size={14} />
              </button>
            </form>
          </div>
        );
      })}
    </div>
  );
}

export default function LoginPage() {
  const { error, notice, email, returnTo, authBase, accounts } = useLoaderData<typeof loader>();
  const hasAccounts = accounts.length > 0;
  return (
    <AuthShell>
      <h1 className="cd-auth-title">Sign in</h1>
      <p className="cd-auth-sub">{hasAccounts ? "Pick an account to continue." : "Welcome back."}</p>
      <AuthError code={error} />
      <AuthNotice notice={notice} />
      {hasAccounts ? (
        <>
          <AccountChooser accounts={accounts} returnTo={returnTo} />
          <div className="cd-auth-divider">or sign in another way</div>
        </>
      ) : null}
      <GoogleButton label="Continue with Google" returnTo={returnTo} baseUrl={authBase} />
      <ShopifyButton label="Continue with Shopify" returnTo={returnTo} baseUrl={authBase} mode="signup" />
      <div className="cd-auth-divider">or</div>
      <AuthForm action="/dashboard/signin">
        <label className="cd-auth-label" htmlFor="email">
          Email
        </label>
        <input
          className="cd-auth-input"
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          defaultValue={email}
          autoFocus={!hasAccounts}
        />
        <label className="cd-auth-label" htmlFor="password">
          Password
        </label>
        <PasswordField id="password" autoComplete="current-password" />
        {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}
        <AuthSubmit label="Sign in" pendingLabel="Signing in…" />
      </AuthForm>
      <div className="cd-auth-links">
        <a href="/reset">Forgot password?</a>
        <a href="/signup">Create an account</a>
      </div>
    </AuthShell>
  );
}
