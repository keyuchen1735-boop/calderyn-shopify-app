// Account cards for the /login and /signup pages: every account previously
// used on this device, resolved server-side by the route loader. A live entry
// is a one-click sign-in (posts the sid selector; the token itself never
// leaves its HttpOnly cookie). A signed-out entry only shortcuts to the
// password form with the email prefilled — device possession alone must not
// reopen an account the user explicitly signed out of. Plain document
// forms/links, so everything works without JS; GSAP (entrance stagger,
// hover-revealed remove control) is an enhancement on top.
//
// Layout note: the remove control cannot nest inside the switch form (nested
// forms are invalid HTML), so its form overlays the card's right edge
// absolutely — the card itself spans the full row like every other auth
// control. On hover the trailing hint (chevron / "Signed out") gives way to
// the remove icon; on touch (no hover) the remove icon is always visible via
// a hover-none media rule in dashboard.css.
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

function deadEntryHref(account: ChooserAccount, returnTo: string | null): string {
  // A threaded connector/deep-link destination must survive re-auth here too —
  // the live one-click form forwards it, so the signed-out fallback must not
  // drop it (both targets re-validate return_to server-side).
  const params = new URLSearchParams();
  // Shop-only sessions (no first-party user) have no password to fall back
  // to — re-entry is the Shopify OAuth flow.
  if (account.email) params.set("email", account.email);
  if (returnTo) params.set("return_to", returnTo);
  const qs = params.toString();
  const base = account.email ? "/login" : "/dashboard/login";
  return qs ? `${base}?${qs}` : base;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function AccountRow({
  account,
  returnTo,
  page,
}: {
  account: ChooserAccount;
  returnTo: string | null;
  page: "/login" | "/signup";
}) {
  const removeRef = useRef<HTMLButtonElement>(null);
  const hintRef = useRef<HTMLSpanElement>(null);

  // Touch devices never fire mouseenter reliably; the hover-none CSS rule
  // keeps the remove icon visible there, so these handlers are desktop-only
  // polish and can safely own the inline styles.
  const reveal = (on: boolean) => {
    if (!removeRef.current || !hintRef.current) return;
    if (window.matchMedia("(hover: none)").matches) return;
    if (prefersReducedMotion()) {
      gsap.set(removeRef.current, { autoAlpha: on ? 1 : 0 });
      gsap.set(hintRef.current, { autoAlpha: on ? 0 : 1 });
      return;
    }
    gsap.to(removeRef.current, {
      autoAlpha: on ? 1 : 0,
      x: on ? 0 : 8,
      scale: on ? 1 : 0.85,
      duration: 0.22,
      ease: on ? "back.out(1.6)" : "power2.in",
      overwrite: "auto",
    });
    gsap.to(hintRef.current, {
      autoAlpha: on ? 0 : 1,
      x: on ? -6 : 0,
      duration: 0.18,
      ease: "power2.out",
      overwrite: "auto",
    });
  };

  const subtitle = account.email ?? account.storeDomain;
  const body = (
    <>
      <span className="cd-auth-account-avatar" aria-hidden>
        {(account.storeName || "C").slice(0, 1).toUpperCase()}
      </span>
      <span className="cd-auth-account-meta">
        <span className="cd-auth-account-store">{account.storeName}</span>
        {subtitle ? <span className="cd-auth-account-email">{subtitle}</span> : null}
      </span>
      <span className="cd-auth-account-hint" ref={hintRef} aria-hidden>
        {account.live ? (
          <CDIcon name="chevronRight" size={16} />
        ) : (
          <span className="cd-auth-account-status">Signed out</span>
        )}
      </span>
    </>
  );

  return (
    <div
      className="cd-auth-account"
      onMouseEnter={() => reveal(true)}
      onMouseLeave={() => reveal(false)}
    >
      {account.live ? (
        <form method="post" action="/dashboard/api/switch-account" className="cd-auth-account-form">
          <input type="hidden" name="sid" value={account.sid} />
          {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}
          <button type="submit" className="cd-auth-account-btn">
            {body}
          </button>
        </form>
      ) : (
        <a className="cd-auth-account-btn" href={deadEntryHref(account, returnTo)}>
          {body}
        </a>
      )}
      <form method="post" action="/dashboard/api/switch-account" className="cd-auth-account-removeform">
        <input type="hidden" name="sid" value={account.sid} />
        <input type="hidden" name="intent" value="remove" />
        <input type="hidden" name="back" value={page} />
        {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}
        <button
          type="submit"
          className="cd-auth-account-remove"
          ref={removeRef}
          onFocus={() => reveal(true)}
          onBlur={() => reveal(false)}
          aria-label={`Remove ${account.storeName} from this device`}
          title="Remove from this device"
        >
          <CDIcon name="x" size={14} />
        </button>
      </form>
    </div>
  );
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
    if (prefersReducedMotion()) return;
    const cards = listRef.current.querySelectorAll(".cd-auth-account");
    const tween = gsap.from(cards, {
      opacity: 0,
      y: 10,
      duration: 0.4,
      ease: "power2.out",
      stagger: 0.06,
      clearProps: "opacity,transform",
    });
    return () => {
      tween.kill();
    };
  }, []);

  return (
    <div className="cd-auth-accounts" ref={listRef}>
      {accounts.map((a) => (
        <AccountRow key={a.sid} account={a} returnTo={returnTo} page={page} />
      ))}
    </div>
  );
}
