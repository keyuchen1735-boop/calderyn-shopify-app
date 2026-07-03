// Plain-language copy for auth flow states. Keys are the stable error codes
// returned by the auth actions (and forwarded via ?error=) plus the
// informational states the pages surface via their own query params.
// Client-safe: strings only.

export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: "That email or password is incorrect.",
  no_shop: "This account exists but has no store attached yet. Contact support and we'll link it.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
  invalid_email: "That doesn't look like a valid email address.",
  weak_password: "Passwords need at least 10 characters.",
  missing_store: "Give your store a name.",
  email_taken: "An account with that email already exists. Try signing in instead.",
  google_oauth_failed: "Google sign-in didn't complete. Try again.",
  google_unavailable: "Google sign-in isn't available right now. Use your email and password.",
  google_unverified_email: "Your Google account's email isn't verified with Google, so we can't use it to sign you in.",
  invalid_or_expired_token: "That link is invalid or has expired. Request a new one.",
  bad_origin: "Something went wrong submitting the form. Reload the page and try again.",
  session_expired: "You were signed out. Sign in again to continue.",
  send_failed: "We couldn't send the email just now. Wait a moment and try again.",
  account_creation_failed: "Something went wrong creating your account. Please try again.",
  oauth_failed: "Shopify sign-in didn't complete. Try again.",
  app_not_installed:
    "Your store approved the connection, but we couldn't finish setting it up on our side. Nothing is lost — try again in a moment.",
  invalid_shop: "Enter your store's .myshopify.com domain, like example.myshopify.com.",
};

export const AUTH_NOTICE_MESSAGES: Record<string, string> = {
  reset: "Password updated. Sign in with your new password.",
  signed_out: "You're signed out.",
  sent: "Email sent. Check your inbox.",
};

export function authErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return AUTH_ERROR_MESSAGES[code] ?? "Something went wrong. Try again.";
}
