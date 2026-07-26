// app/routes/signup.tsx
// Account creation page on the app origin. The form posts to /dashboard/signup
// (user + owned shop + session + verification email); this page owns the UI
// and friendly error states. "Get started" on the marketing site lands here,
// so a returning visitor is greeted with their remembered accounts (same
// chooser as /login) instead of a cold create-account form; an already
// signed-in visitor skips straight to the dashboard.
import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import dashboard from "~/styles/dashboard.css?url";
import { safeDashboardReturnTo, publicBaseUrl } from "~/lib/dashboard/http.server";
import { getSessionFromRequest } from "~/lib/dashboard/session.server";
import {
  resolveRememberedAccounts,
  type RememberedAccount,
} from "~/lib/auth/remembered-accounts.server";
import {
  AuthShell,
  AuthError,
  AuthForm,
  AuthSubmit,
  PasswordField,
  GoogleButton,
} from "~/components/auth/AuthCard";
import { AccountChooser } from "~/components/auth/AccountChooser";

export const meta: MetaFunction = () => [{ title: "Create your account — Calderyn" }];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboard }];

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  // Already signed in? "Get started" means the dashboard, not a second account.
  const session = await getSessionFromRequest(request);
  if (session) {
    return redirect(safeDashboardReturnTo(url.searchParams.get("return_to")) ?? "/dashboard");
  }

  // Remembered accounts on this device — a returning merchant who clicked
  // "Get started" should be offered their account, not a signup form.
  // Best-effort: a DB hiccup must not take down the signup page.
  let accounts: RememberedAccount[] = [];
  let accountsCookie: string | null = null;
  try {
    ({ accounts, cookieHeader: accountsCookie } = await resolveRememberedAccounts(request));
  } catch (err) {
    console.error("[signup] remembered-accounts resolve failed", err);
  }

  return json(
    {
      error: url.searchParams.get("error"),
      email: url.searchParams.get("email") ?? "",
      store: url.searchParams.get("store") ?? "",
      // Threaded connector/deep-link destination; carried through signup +
      // onboarding so an interrupted flow resumes. Validated here (parity with
      // login.tsx) as well as at the action, so a hostile value never reaches the form.
      returnTo: safeDashboardReturnTo(url.searchParams.get("return_to")) ?? "",
      // Marker indicating signup started from the login page's Shopify button.
      fromShopify: url.searchParams.get("from") === "shopify",
      // OAuth provider flows must start on the public apex (their callback host),
      // not this app.* origin — see GoogleButton.
      authBase: publicBaseUrl(),
      accounts,
    },
    accountsCookie ? { headers: { "Set-Cookie": accountsCookie } } : undefined,
  );
}

export default function SignupPage() {
  const { error, email, store, returnTo, authBase, fromShopify, accounts } =
    useLoaderData<typeof loader>();
  const hasAccounts = accounts.length > 0;
  return (
    <AuthShell>
      <h1 className="cd-auth-title">{hasAccounts ? "Welcome back" : "Create account"}</h1>
      <p className="cd-auth-sub">
        {hasAccounts ? "Pick up where you left off." : "Live in about a minute."}
      </p>
      <AuthError code={error} />
      {fromShopify && (
        <p className="cd-auth-sub">
          Create your account first — you'll connect your Shopify store and import
          everything right after.
        </p>
      )}
      {hasAccounts ? (
        <>
          {/* returnTo rides through unvalidated here (same as the signup form's
              hidden field) — the switch action re-validates it before use. */}
          <AccountChooser accounts={accounts} returnTo={returnTo || null} page="/signup" />
          <div className="cd-auth-divider">or create a new account</div>
        </>
      ) : null}
      <GoogleButton label="Sign up with Google" baseUrl={authBase} />
      <div className="cd-auth-divider">or</div>
      <AuthForm action="/dashboard/signup">
        {returnTo && <input type="hidden" name="return_to" value={returnTo} />}
        <label className="cd-auth-label" htmlFor="store">
          Store name
        </label>
        <input
          className="cd-auth-input"
          id="store"
          name="store"
          type="text"
          required
          autoComplete="organization"
          defaultValue={store}
          placeholder="e.g. Northbound Supply"
          autoFocus={!hasAccounts}
        />
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
        />
        <label className="cd-auth-label" htmlFor="password">
          Password
        </label>
        <PasswordField id="password" autoComplete="new-password" minLength={10} />
        <p className="cd-auth-hint">At least 10 characters.</p>
        <AuthSubmit label="Create account" pendingLabel="Creating account…" />
      </AuthForm>
      <p className="cd-auth-foot">We'll email you a link to verify your address.</p>
      <p className="cd-auth-foot">
        Already have an account? <a href="/login">Sign in</a>
      </p>
    </AuthShell>
  );
}
