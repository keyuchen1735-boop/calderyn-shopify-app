// Radar's merchant-facing pieces, folded into existing surfaces: the drafted
// moves queue lives inside Autopilot (OvernightMoves) and the observational
// signals live inside Analytics > Live (LiveRadarSignals). Both talk to the
// unchanged /dashboard/api/radar endpoint via radar-client and share the
// screen-cache "radar" key (seed + write-through; WARM_TARGETS keeps it hot).
import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardCtx } from "../context";
import { Card, Btn, SkelBar } from "../ui";
import { cachedScreenData, cacheScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import { DashboardApiError } from "~/lib/dashboard/client";
import {
  applyRadarMove,
  confirmRadarCompetitor,
  dismissRadarCompetitor,
  dismissRadarMove,
  fetchRadar,
  RADAR_KIND_LABELS,
  refreshRadar,
  revertRadarMove,
  type RadarCompetitorVM,
  type RadarMoveVM,
  type RadarOverviewVM,
} from "~/lib/dashboard/radar-client";

function whenLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Formats a plain YYYY-MM-DD (no time-of-day, e.g. a snapshot's captured
 *  day) as that exact calendar date, regardless of the viewer's timezone.
 *  `new Date("2026-07-20")` parses as UTC midnight - naively formatting it
 *  with `toLocaleDateString` in a timezone behind UTC (most of the Americas)
 *  renders the PRIOR day. Passing timeZone: "UTC" keeps the label pinned to
 *  the date the string actually names. */
function dayLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return whenLabel(day);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Kind labels (the merchant-facing groupings already in RADAR_KIND_LABELS)
 *  whose one-click approve changes something the merchant would recognize as
 *  "the store page" - used to give the approve toast a concrete receipt
 *  instead of a generic acknowledgement. */
const STORE_PAGE_RECEIPT_LABELS = new Set(["Store page", "Google ranking", "AI assistants"]);

/** A plain-language receipt for a successful approve. Every move that reaches
 *  the main Approve button (as opposed to the review path's "Mark done") is
 *  guaranteed by the drafter to be a real site-changing apply - see
 *  detect*.server.ts, every "review" applyMode always carries a deepLink and
 *  so never lands here - so this only decides HOW concrete the receipt reads,
 *  never whether one is warranted. */
function applyReceiptMessage(m: RadarMoveVM): string {
  const label = RADAR_KIND_LABELS[m.kind];
  return label && STORE_PAGE_RECEIPT_LABELS.has(label)
    ? "Applied — your store page was updated."
    : "Applied. You can undo it below.";
}

/** Shared load/refresh/action state for both folded surfaces. `instantCheck`
 *  keeps the PR #627 behavior with the queue (now in Autopilot): one
 *  rate-limited check per mount when the data is stale, plus the manual
 *  "Check now" path. The Live signals view passes false and only reads. */
function useRadarOverview(app: Pick<DashboardCtx, "toast">, instantCheck: boolean) {
  const { toast } = app;
  const [data, setData] = useState<RadarOverviewVM | null>(() =>
    cachedScreenData<RadarOverviewVM>(SCREEN_CACHE_KEYS.radar),
  );
  const [loadError, setLoadError] = useState(false);
  const [freshLookBanner, setFreshLookBanner] = useState(false);
  const [checkingNow, setCheckingNow] = useState(false);
  const autoRefreshedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const fresh = await fetchRadar();
      cacheScreenData(SCREEN_CACHE_KEYS.radar, fresh);
      setData(fresh);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The engine runs nightly, but opening the queue on stale (or never
  // collected) data should feel instant: fire one rate-limited check per
  // mount and quietly refetch once it lands.
  useEffect(() => {
    if (!instantCheck || !data?.stale || autoRefreshedRef.current) return;
    autoRefreshedRef.current = true;
    setFreshLookBanner(true);
    void refreshRadar()
      .then(async () => {
        // Refetch either way: refreshed=true means the drafter just ran on
        // our behalf; refreshed=false ("fresh") means another session
        // already refreshed since our cached snapshot landed - either way
        // there may be newer data than what this mount loaded with, and
        // autoRefreshedRef above already caps this to one run per mount.
        await load();
      })
      .catch(() => {
        // Best-effort: the section still works off whatever data it has.
      })
      .finally(() => setFreshLookBanner(false));
  }, [instantCheck, data, load]);

  const checkNow = useCallback(async () => {
    setCheckingNow(true);
    try {
      const res = await refreshRadar();
      if (res.refreshed) {
        await load();
        toast(
          res.drafted && res.drafted > 0
            ? `Just checked your store. ${res.drafted} new move${res.drafted === 1 ? "" : "s"} to review.`
            : "Just checked your store",
          "check",
        );
      } else {
        toast("Already checked recently", "clock");
      }
    } catch (err) {
      toast(err instanceof DashboardApiError ? err.message : "That didn't go through. Try again.", "warn", "critical");
    } finally {
      setCheckingNow(false);
    }
  }, [load, toast]);

  return { data, loadError, freshLookBanner, checkingNow, load, checkNow };
}

/* ---------- Autopilot: the drafted-moves queue ---------- */

/** The overnight queue, sectioned with Autopilot's own recommendations.
 *  Approve = the radar apply action, Dismiss = radar dismiss; recently
 *  applied moves keep their revert (with the two-step 409 confirm flow).
 *  Purely presentational fold - moves never become autopilot alert rows. */
export function OvernightMoves({ app }: { app: DashboardCtx }) {
  const { toast, relTime } = app;
  const { data, loadError, freshLookBanner, checkingNow, load, checkNow } = useRadarOverview(app, true);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Two-step revert: a conflict (409 revert_conflict) arms the button; the
  // second click sends confirm=true.
  const [armedRevertId, setArmedRevertId] = useState<string | null>(null);

  const run = useCallback(
    async (move: RadarMoveVM, fn: () => Promise<unknown>, doneMsg: string) => {
      setBusyId(move.id);
      try {
        await fn();
        toast(doneMsg, "check");
        await load();
      } catch (err) {
        if (err instanceof DashboardApiError && err.code === "revert_conflict") {
          setArmedRevertId(move.id);
          toast(`${err.message} Click Revert again to continue.`, "warn", "critical");
        } else {
          toast(err instanceof DashboardApiError ? err.message : "That didn't go through. Try again.", "warn", "critical");
        }
      } finally {
        setBusyId(null);
      }
    },
    [load, toast],
  );

  const moves = data?.moves ?? [];
  const revertable = (data?.history ?? []).filter((m) => m.canRevert).slice(0, 5);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }} aria-label="Overnight moves">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <h2 className="cd-h2" style={{ margin: 0 }}>
            Overnight moves{moves.length > 0 ? ` (${moves.length})` : ""}
          </h2>
          <p className="cd-caption" style={{ margin: "2px 0 0" }}>
            Calderyn checks your traffic, Google results and AI assistants overnight and drafts changes
            for your approval. Nothing changes on your store until you approve it.
            {data?.lastCheckedAt ? ` Checked ${relTime(Date.parse(data.lastCheckedAt))}.` : ""}
          </p>
        </div>
        <Btn disabled={checkingNow || freshLookBanner} onClick={() => void checkNow()}>
          {checkingNow ? "Checking…" : "Check now"}
        </Btn>
      </div>

      {freshLookBanner && (
        <p className="cd-caption" style={{ margin: 0 }}>
          Taking a fresh look at your store. New moves will show up here in a moment.
        </p>
      )}

      {!data ? (
        loadError ? (
          <p className="cd-caption" style={{ margin: 0 }}>
            Couldn&apos;t load drafted moves.{" "}
            <button type="button" className="cd-btn cd-btn-secondary cd-btn-sm" onClick={() => void load()}>
              Try again
            </button>
          </p>
        ) : (
          <SkelBar width="40%" />
        )
      ) : moves.length === 0 ? (
        !freshLookBanner && (
          <p className="cd-caption" style={{ margin: 0 }}>
            {data.stale
              ? "When something needs attention, a drafted move appears here for your approval."
              : "Nothing needs your attention right now."}
          </p>
        )
      ) : (
        moves.map((m) => (
          <Card key={m.id}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span className="cd-chip">{RADAR_KIND_LABELS[m.kind] ?? "Store"}</span>
              {m.chips.map((c, i) => (
                <span key={i} className="cd-chip">{c}</span>
              ))}
            </div>
            <h3 style={{ margin: "8px 0 4px" }}>{m.headline}</h3>
            <p className="cd-caption">{m.rationale}</p>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              {m.reviewOnly && m.deepLink ? (
                <>
                  <Btn kind="primary" onClick={() => {
                    // Every real deep link is a same-origin dashboard route; anything else is
                    // ignored rather than handed straight to window.location.
                    if (m.deepLink?.startsWith("/dashboard/")) window.location.href = m.deepLink;
                  }}>
                    Review
                  </Btn>
                  <Btn disabled={busyId === m.id}
                    onClick={() => void run(m, () => applyRadarMove(m.id), "Marked done.")}>
                    Mark done
                  </Btn>
                </>
              ) : (
                <Btn kind="primary" disabled={busyId === m.id}
                  onClick={() => void run(m, () => applyRadarMove(m.id), applyReceiptMessage(m))}>
                  {busyId === m.id ? "Approving…" : "Approve"}
                </Btn>
              )}
              <Btn disabled={busyId === m.id}
                onClick={() => void run(m, () => dismissRadarMove(m.id), "Dismissed.")}>
                Dismiss
              </Btn>
            </div>
          </Card>
        ))
      )}

      {revertable.length > 0 && (
        <>
          <p className="cd-caption" style={{ margin: 0 }}>Recently applied</p>
          {revertable.map((m) => (
            <Card key={m.id}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ flex: 1, minWidth: 0 }}>{m.headline}</span>
                <span className="cd-caption" style={{ margin: 0 }}>
                  {whenLabel(m.appliedAt ?? m.resolvedAt ?? m.createdAt)}
                </span>
                <Btn disabled={busyId === m.id}
                  onClick={() => void run(m, () => revertRadarMove(m.id, armedRevertId === m.id), "Reverted.")}>
                  {armedRevertId === m.id ? "Revert (overwrites newer edits)" : "Revert"}
                </Btn>
              </div>
            </Card>
          ))}
        </>
      )}
    </section>
  );
}

/* ---------- Analytics > Live: the observational signals ---------- */

function SignalStat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Card className="cd-stat">
      <span className="cd-stat-label">{label}</span>
      <span className="cd-stat-value tabular-nums">{value}</span>
      <span className="cd-caption">{note}</span>
    </Card>
  );
}

/** Radar's watch signals on the Live board: AI-assistant crawler visits, the
 *  Google summary, and the competitor watch list with its recent-changes
 *  timeline (confirm/dismiss for suggested stores lives here now). Read-only
 *  against the same overview payload the Autopilot queue uses - the instant
 *  check stays with the queue, this view never triggers one. */
export function LiveRadarSignals({ app }: { app: DashboardCtx }) {
  const { toast } = app;
  const { data, load } = useRadarOverview(app, false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const runCompetitor = useCallback(
    async (competitorId: string, fn: () => Promise<unknown>, doneMsg: string | ((result: unknown) => string)) => {
      setBusyId(competitorId);
      try {
        const result = await fn();
        toast(typeof doneMsg === "function" ? doneMsg(result) : doneMsg, "check");
        await load();
      } catch (err) {
        toast(err instanceof DashboardApiError ? err.message : "That didn't go through. Try again.", "warn", "critical");
      } finally {
        setBusyId(null);
      }
    },
    [load, toast],
  );

  // Warm-up only: until the overview lands the Live board simply doesn't show
  // this block - its own visitors/sales content owns the loading experience.
  if (!data) return null;

  const { signals, competitors } = data;
  const noCompetitors = competitors.suggested.length === 0 && competitors.watching.length === 0;

  return (
    <div className="cd-grid-main">
      <div className="flex flex-col gap-4 min-w-0">
        <SignalStat
          label="AI assistant visits"
          value={String(signals.aiAssistants.hitsLast7)}
          note={`AI assistants reading your store, last 7 days · ${signals.aiAssistants.hitsPrior7} the week before`}
        />
        <SignalStat
          label="Google"
          value={signals.google.connected ? `${signals.google.slippingCount} pages slipping` : "Not connected"}
          note={
            signals.google.connected
              ? signals.google.lastCapturedDate
                ? `Data through ${signals.google.lastCapturedDate}`
                : "Waiting for first data"
              : "Connect Google in Store > Preferences"
          }
        />
      </div>

      <div className="flex flex-col gap-4 min-w-0">
        <Card>
          <h2 className="cd-h2">Competitor watch</h2>
          {noCompetitors && (
            <p className="cd-caption">
              Once your store is live, Calderyn searches the web weekly for stores selling similar
              products and lists them here. Nothing is watched until you confirm it.
            </p>
          )}

          {competitors.suggested.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
              <h3 style={{ margin: 0 }}>Suggested</h3>
              <p className="cd-caption" style={{ margin: 0 }}>
                Found by web search - listed stores aren&apos;t affiliated with Calderyn. Confirm the
                ones you want watched; watched stores are checked nightly.
              </p>
              {competitors.suggested.map((c: RadarCompetitorVM) => (
                <div key={c.id}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong>{c.name}</strong>
                    <span className="cd-chip">{c.host}</span>
                  </div>
                  {c.reason && <p className="cd-caption" style={{ margin: "4px 0 0" }}>{c.reason}</p>}
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <Btn kind="primary" small disabled={busyId === c.id}
                      onClick={() => void runCompetitor(c.id, () => confirmRadarCompetitor(c.id), (result) =>
                        (result as { firstLook?: boolean } | undefined)?.firstLook
                          ? "Watching. Calderyn took its first look at their site."
                          : "Watching. Calderyn checks it nightly.")}>
                      {busyId === c.id ? "Confirming…" : "Watch this store"}
                    </Btn>
                    <Btn small disabled={busyId === c.id}
                      onClick={() => void runCompetitor(c.id, () => dismissRadarCompetitor(c.id), "Dismissed.")}>
                      Dismiss
                    </Btn>
                  </div>
                </div>
              ))}
            </div>
          )}

          {competitors.watching.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
              <h3 style={{ margin: 0 }}>
                Watching ({competitors.watching.length}/{competitors.watchLimit})
              </h3>
              {competitors.watching.map((c: RadarCompetitorVM) => (
                <div key={c.id}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong>{c.name}</strong>
                    <span className="cd-chip">{c.host}</span>
                  </div>
                  {c.changes.length === 0 ? (
                    <p className="cd-caption" style={{ margin: "4px 0 0" }}>
                      No changes spotted yet. Checked nightly.
                    </p>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                      {c.changes.map((ch, i) => (
                        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <span className="cd-caption" style={{ margin: 0 }}>{dayLabel(ch.day)}</span>
                          {ch.chips.map((chip, j) => (
                            <span key={j} className="cd-chip">{chip}</span>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <Btn small disabled={busyId === c.id}
                      onClick={() => void runCompetitor(c.id, () => dismissRadarCompetitor(c.id), "Stopped watching.")}>
                      Stop watching
                    </Btn>
                  </div>
                  <p className="cd-caption" style={{ margin: "4px 0 0" }}>
                    Calderyn will stop watching this competitor and won&apos;t suggest it again.
                  </p>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
