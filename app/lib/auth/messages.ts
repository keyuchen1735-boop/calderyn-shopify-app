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
};

export const AUTH_NOTICE_MESSAGES: Record<string, string> = {
  reset: "Password updated. Sign in with your new password.",
  signed_out: "You're signed out.",
  sent: "Email sent — check your inbox.",
};

export function authErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return AUTH_ERROR_MESSAGES[code] ?? "Something went wrong. Try again.";
}
