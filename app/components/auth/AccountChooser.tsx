// Account cards for the /login and /signup pages: every account previously
// used on this device, resolved server-side by the route loader. A live entry
// is a one-click sign-in (posts the sid selector; the token itself never
// leaves its HttpOnly cookie). A signed-out entry only shortcuts to the
// password form with the email prefilled — device possession alone must not
// reopen an account the user explicitly signed out of. Plain document
// forms/links, so everything works without JS; GSAP entrance is an
// enhancement on top.
import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { CDIcon } from "~/components/dashboard/icons";

export type ChooserAccount = {
  sid: string;
  email: string | null;
  storeName: string;
  storeDomain: string | null;
  live: boolean;
};

function deadEntryHref(account: ChooserAccount): string {
  // Shop-only sessions (no first-party user) have no password to fall back
  // to — re-entry is the Shopify OAuth flow.
  if (!account.email) return "/dashboard/login";
  return `/login?email=${encodeURIComponent(account.email)}`;
}

export function AccountChooser({
  accounts,
  returnTo,
  page = "/login",
}: {
  accounts: ChooserAccount[];
  returnTo: string | null;
  /** Which auth page hosts the chooser — a remove round-trips back to it. */
  page?: "/login" | "/signup";
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
        const body = (
          <>
            <span className="cd-auth-account-avatar" aria-hidden>
              {(a.storeName || "C").slice(0, 1).toUpperCase()}
            </span>
            <span className="cd-auth-account-meta">
              <span className="cd-auth-account-store">{a.storeName}</span>
              {subtitle ? <span className="cd-auth-account-email">{subtitle}</span> : null}
            </span>
            {a.live ? (
              <CDIcon name="chevronRight" size={16} />
            ) : (
              <span className="cd-auth-account-status">Signed out</span>
            )}
          </>
        );
        return (
          <div className="cd-auth-account" key={a.sid}>
            {a.live ? (
              <form
                method="post"
                action="/dashboard/api/switch-account"
                className="cd-auth-account-form"
              >
                <input type="hidden" name="sid" value={a.sid} />
                {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}
                <button type="submit" className="cd-auth-account-btn">
                  {body}
                </button>
              </form>
            ) : (
              <span className="cd-auth-account-form">
                <a className="cd-auth-account-btn" href={deadEntryHref(a)}>
                  {body}
                </a>
              </span>
            )}
            <form method="post" action="/dashboard/api/switch-account">
              <input type="hidden" name="sid" value={a.sid} />
              <input type="hidden" name="intent" value="remove" />
              <input type="hidden" name="back" value={page} />
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
