// app/components/dashboard/use-live-analytics.ts
// Refresh model for the Analytics Live subtab: a 60s poll gated on subtab +
// document visibility, plus a Supabase Realtime "order ping" (INSERT at
// checkout creation, UPDATE on the paid flip) that triggers an immediate
// refetch. The ping carries no data — aggregation only ever lives server-side.
// Realtime failing or unconfigured (503) degrades silently to the poll. The
// realtime JWT expires hourly, so the subscription re-mints itself shortly
// before expiry.
import { useEffect, useRef, useState } from "react";
import {
  createClient,
  type SupabaseClient,
  type RealtimeChannel,
} from "@supabase/supabase-js";
import {
  fetchLiveAnalytics,
  getRealtimeToken,
  DashboardApiError,
  type LiveAnalyticsSnapshot,
} from "~/lib/dashboard/client";
import { useRefreshOnFocus } from "~/lib/use-refresh-on-focus";

export const LIVE_POLL_MS = 60_000;
// Re-mint the realtime JWT a minute before it lapses.
const TOKEN_RENEW_SLACK_MS = 60_000;

/** Pure gate: poll only when the Live subtab is active and the tab is visible. */
export function shouldPollNow(active: boolean, visibility: DocumentVisibilityState): boolean {
  return active && visibility === "visible";
}

export function useLiveAnalytics(active: boolean): {
  snapshot: LiveAnalyticsSnapshot | null;
  error: string | null;
} {
  const [snapshot, setSnapshot] = useState<LiveAnalyticsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef<(() => void) | null>(null);

  // Visibility/focus refetch rides the shared cooldown hook rather than a raw
  // visibilitychange listener, so rapid tab switching can't stampede the API.
  // The ref bridge keeps the main effect (and its realtime socket) untouched.
  useRefreshOnFocus(() => loadRef.current?.(), { enabled: active });

  useEffect(() => {
    if (!active) return;
    let alive = true;
    // Monotonic request ordering: a slow, older response must never overwrite
    // a newer snapshot (poll and order-ping loads can overlap).
    let issued = 0;
    let applied = 0;

    const load = () => {
      if (!shouldPollNow(active, document.visibilityState)) return;
      const seq = ++issued;
      fetchLiveAnalytics()
        .then((s) => {
          if (!alive || seq < applied) return;
          applied = seq;
          setSnapshot(s);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          // Keep the last good snapshot on transient failures; the view only
          // falls back to the error placeholder when it has nothing to show.
          setError(err instanceof DashboardApiError ? err.message : "Couldn't load live view.");
        });
    };

    loadRef.current = load;
    load();
    const id = setInterval(load, LIVE_POLL_MS);

    // --- realtime order ping (enhancement; the poll is the contract) ---
    let sb: SupabaseClient | null = null;
    let channel: RealtimeChannel | null = null;
    let renewTimer: ReturnType<typeof setTimeout> | null = null;

    const teardownRealtime = () => {
      if (renewTimer) clearTimeout(renewTimer);
      renewTimer = null;
      if (sb && channel) void sb.removeChannel(channel);
      channel = null;
      sb = null;
    };

    const subscribe = async () => {
      try {
        const tok = await getRealtimeToken();
        if (!alive || !tok) return; // 503 → poll-only fallback, silently
        teardownRealtime();
        // The socket handshake needs a real (public) API key — the hosted
        // gateway rejects self-minted JWTs as apikey. The shop-scoped JWT
        // authorizes the channel via setAuth.
        sb = createClient(tok.url, tok.publishableKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        sb.realtime.setAuth(tok.token);
        channel = sb
          .channel("live-orders")
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "orders",
              // RLS is the tenant boundary; this filter is defense in depth
              // and keeps the server from evaluating other shops' changes.
              filter: `shop_id=eq.${tok.shopId}`,
            },
            () => load(),
          )
          .subscribe();
        // The JWT lapses after an hour — re-mint and resubscribe before then.
        const renewInMs = Math.max(
          new Date(tok.expiresAt).getTime() - Date.now() - TOKEN_RENEW_SLACK_MS,
          TOKEN_RENEW_SLACK_MS,
        );
        renewTimer = setTimeout(() => void subscribe(), renewInMs);
      } catch {
        // realtime is an enhancement; the poll is the contract
      }
    };
    void subscribe();

    return () => {
      alive = false;
      loadRef.current = null;
      clearInterval(id);
      teardownRealtime();
    };
  }, [active]);

  return { snapshot, error };
}
