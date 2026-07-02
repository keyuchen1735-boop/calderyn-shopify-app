// app/components/dashboard/use-live-analytics.ts
// Refresh model for the Analytics Live subtab (spec
// 2026-07-02-analytics-live-view-design.md): 60s poll gated on subtab +
// document visibility, plus a Supabase Realtime "order ping" (INSERT at
// checkout creation, UPDATE on the paid flip) that triggers an immediate
// refetch. The ping carries no data — aggregation only ever lives server-side.
// Realtime failing/unconfigured (503) degrades silently to the poll. First
// real consumer of getRealtimeToken().
import { useEffect, useState } from "react";
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

export const LIVE_POLL_MS = 60_000;

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

  useEffect(() => {
    if (!active) return;
    let alive = true;

    const load = () => {
      if (!shouldPollNow(active, document.visibilityState)) return;
      fetchLiveAnalytics()
        .then((s) => {
          if (!alive) return;
          setSnapshot(s);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setError(err instanceof DashboardApiError ? err.message : "Couldn't load live view.");
        });
    };

    load();
    const id = setInterval(load, LIVE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);

    let sb: SupabaseClient | null = null;
    let channel: RealtimeChannel | null = null;
    getRealtimeToken()
      .then((tok) => {
        if (!alive || !tok) return; // 503 → poll-only fallback, silently
        sb = createClient(tok.url, tok.token, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        sb.realtime.setAuth(tok.token);
        channel = sb
          .channel("live-orders")
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "orders" }, // RLS scopes delivery to this shop
            () => load(),
          )
          .subscribe();
      })
      .catch(() => {
        // realtime is an enhancement; the poll is the contract
      });

    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      if (sb && channel) void sb.removeChannel(channel);
    };
  }, [active]);

  return { snapshot, error };
}
