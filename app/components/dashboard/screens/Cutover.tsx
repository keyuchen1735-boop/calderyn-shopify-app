import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardCtx } from "../context";
import { Card, SectionTitle } from "../ui";
import { CDIcon } from "../icons";
import { SettingsSubTabs } from "../subtabs";
import { money } from "../format";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import { TEST_TX_PARAM, TEST_TX_SUCCESS, TEST_TX_CANCELLED } from "~/lib/cutover/test-tx-return";

// Go live (platform pivot Step 9, slice 3): the merchant-facing cutover surface.
// Shows where the store is on the mirror -> importing -> dual run -> live path, the
// go-live checklist (parity + payment gates, verbatim from the server), and the legal
// next moves. The server re-runs every gate on any move to live; the buttons here are
// convenience, never the enforcement.

const MODE_META: Record<client.CutoverMode, { title: string; blurb: string }> = {
  mirror: {
    title: "Connected to Shopify",
    blurb: "Calderyn keeps a full copy of your Shopify store and runs your analytics.",
  },
  importing: {
    title: "Importing",
    blurb: "Your products, stock, and order history are being copied into Calderyn.",
  },
  dual_run: {
    title: "Dual run",
    blurb: "Both systems run side by side while you confirm everything matches.",
  },
  live: {
    title: "Live on Calderyn",
    blurb: "Calderyn is your store's home. Prices and stock change here first.",
  },
};

const MODE_ORDER: client.CutoverMode[] = ["mirror", "importing", "dual_run", "live"];

interface MoveMeta {
  label: string;
  primary: boolean;
  /** Risky moves ask for a second click before firing. */
  confirm: boolean;
}

const MOVES: Record<string, MoveMeta> = {
  "mirror->importing": { label: "Start cutover", primary: true, confirm: false },
  "importing->dual_run": { label: "Start dual run", primary: true, confirm: false },
  "importing->mirror": { label: "Cancel and stay on Shopify", primary: false, confirm: true },
  "dual_run->live": { label: "Go live on Calderyn", primary: true, confirm: true },
  "dual_run->mirror": { label: "Cancel and stay on Shopify", primary: false, confirm: true },
  "live->dual_run": { label: "Roll back to dual run", primary: false, confirm: true },
};

// After the test transaction's Stripe redirect, the webhook that flips the gates can
// lag the browser by up to ~a minute — poll the checklist instead of racing it once.
// Fixed 5s x 24 = a 2-minute budget; note each poll runs the full server-side gate
// evaluation, so if this ever needs to be cheaper, add a payment-only status endpoint.
const PROBE_POLL_MS = 5_000;
const PROBE_POLL_MAX = 24;

type ProbeState = "waiting" | "timeout" | "cancelled";

// The waiting flag survives screen swaps (component state does not): a merchant who
// hops to another tab mid-confirmation must find the wait still running on return.
const PROBE_WAIT_KEY = "cd-test-tx-waiting";

const PROBE_NOTE: Record<ProbeState, { icon: string; text: string }> = {
  waiting: {
    icon: "rotate",
    text: "Waiting for Stripe to confirm the test payment — this usually takes under a minute.",
  },
  timeout: {
    icon: "clock",
    text: "Stripe hasn't confirmed the payment yet. Give it a minute, then use Re-check.",
  },
  cancelled: {
    icon: "x",
    text: "Test checkout cancelled — you haven't been charged.",
  },
};

function DriftList({
  title,
  count,
  rows,
  format,
}: {
  title: string;
  count: number;
  rows: client.DriftRowVM[];
  format: (n: number) => string;
}) {
  if (count === 0) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <p className="cd-caption" style={{ fontWeight: 650, margin: 0 }}>
        {title}: {count}
      </p>
      <ul style={{ listStyle: "none", margin: "4px 0 0", padding: 0 }}>
        {rows.map((r, i) => (
          <li
            key={`${r.variantId}:${r.locationId ?? i}`}
            className="cd-caption"
            style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "3px 0" }}
          >
            <CDIcon name="x" size={14} strokeWidth={2.2} style={{ marginTop: 1, flexShrink: 0 }} />
            <span>
              {r.label}: Calderyn {format(r.owned)}, Shopify {format(r.shopify)}
            </span>
          </li>
        ))}
      </ul>
      {rows.length < count && (
        <p className="cd-caption" style={{ opacity: 0.7, margin: "4px 0 0" }}>
          Showing the first {rows.length} of {count}.
        </p>
      )}
    </div>
  );
}

export default function Cutover({ app }: { app: DashboardCtx }) {
  const [status, setStatus] = useState<client.CutoverStatusVM | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<client.CutoverMode | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [drift, setDrift] = useState<client.DriftReportVM | null>(null);
  const [driftBusy, setDriftBusy] = useState(false);
  const [driftError, setDriftError] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  // Return leg of the test transaction (marker set by its Stripe return URLs):
  // "waiting" = back from checkout, polling until the webhook flips the payment checks.
  const [probe, setProbe] = useState<ProbeState | null>(null);

  // A back/forward-cache restore (browser Back from Stripe) keeps component state;
  // re-enable the button so returning that way never strands it at "Starting…".
  useEffect(() => {
    const onPageShow = () => setTestBusy(false);
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  const runTestTransaction = useCallback(async () => {
    setTestBusy(true);
    setTestError(null);
    setProbe(null);
    window.sessionStorage.removeItem(PROBE_WAIT_KEY);
    try {
      const { url } = await client.startTestTransaction();
      // Same-tab on purpose: window.open after an await is outside the user-gesture
      // stack and Safari popup-blocks it (returning null, silently). The Stripe
      // return URLs bring the merchant straight back to this screen.
      window.location.assign(url);
    } catch (e) {
      setTestError(e instanceof Error ? e.message : "Could not start test transaction");
      setTestBusy(false);
    }
  }, []);

  // Monotonic fetch guard: concurrent load() calls (poll tick, Re-check, a move)
  // resolve out of order; only the newest response may win.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const next = await client.fetchCutoverStatus();
      if (seq === loadSeq.current) setStatus(next);
    } catch {
      /* transient fetch failure; keep the last known state */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Read (and strip) the test transaction's return marker once on mount, so a refresh
  // or a re-mount never replays it. Preserve the router's history state and the hash —
  // same as the one-shot notice strip in DashboardApp — so back/forward and scroll
  // restoration keep working.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get(TEST_TX_PARAM);
    if (!outcome) {
      // No marker, but a wait was in flight when this screen last unmounted
      // (tab switch mid-confirmation): resume it.
      if (window.sessionStorage.getItem(PROBE_WAIT_KEY)) setProbe("waiting");
      return;
    }
    params.delete(TEST_TX_PARAM);
    const qs = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
    );
    if (outcome === TEST_TX_SUCCESS) {
      window.sessionStorage.setItem(PROBE_WAIT_KEY, "1");
      setProbe("waiting");
    } else if (outcome === TEST_TX_CANCELLED) {
      window.sessionStorage.removeItem(PROBE_WAIT_KEY);
      setProbe("cancelled");
    }
  }, []);

  // While waiting on the webhook, re-check the gates on a bounded cadence. Deps are
  // deliberately just [probe, load] (both stable): the interval must survive parent
  // re-renders and status churn, or the budget never trips. One tick in flight at a
  // time; the verdict itself is consumed by the effect below.
  useEffect(() => {
    if (probe !== "waiting") return;
    let polls = 0;
    let inFlight = false;
    const id = window.setInterval(async () => {
      if (inFlight) return;
      if (polls >= PROBE_POLL_MAX) {
        window.sessionStorage.removeItem(PROBE_WAIT_KEY);
        setProbe("timeout");
        return;
      }
      polls += 1;
      inFlight = true;
      try {
        await load();
      } finally {
        inFlight = false;
      }
    }, PROBE_POLL_MS);
    return () => window.clearInterval(id);
  }, [probe, load]);

  // The payment checks flipped while we were waiting (or even after the waiting
  // budget timed out): clear the note and confirm. Early-returns make the unstable
  // `app` identity harmless here.
  useEffect(() => {
    if (probe !== "waiting" && probe !== "timeout") return;
    if (!status?.gates.paymentCleared) return;
    window.sessionStorage.removeItem(PROBE_WAIT_KEY);
    setProbe(null);
    app.toast("Test payment confirmed.", "check");
  }, [app, probe, status]);

  const move = useCallback(
    async (to: client.CutoverMode) => {
      const meta = MOVES[`${status?.mode}->${to}`];
      if (meta?.confirm && armed !== to) {
        setArmed(to);
        return;
      }
      setArmed(null);
      setBusy(true);
      setBlocked(null);
      try {
        const next = await client.requestCutoverTransition(to);
        // Invalidate any status GET still in flight — it predates this transition.
        loadSeq.current += 1;
        setStatus(next);
        // A COMPLETED mode move invalidates any drift comparison shown so far — never
        // let a pre-move "Everything matches" survive into the new mode as if current.
        // A blocked move changed nothing, so its comparison stays (it may be the very
        // evidence explaining the block).
        setDrift(null);
        setDriftError(null);
        app.toast(
          to === "live" ? "Your store is live on Calderyn." : "Cutover step applied.",
          "rocket",
        );
      } catch (err) {
        const msg =
          err instanceof DashboardApiError ? err.message : "That step could not be applied.";
        setBlocked(msg);
        // "details", not "checklist": a value-parity block arrives with an all-green
        // structural checklist — the reason lives in the blocked text (and drift panel).
        app.toast("That step is blocked. See the details below.", "warn", "critical");
        await load();
      } finally {
        setBusy(false);
      }
    },
    [app, armed, load, status],
  );

  const runDrift = useCallback(async () => {
    setDriftBusy(true);
    setDriftError(null);
    try {
      setDrift(await client.fetchCutoverDrift());
    } catch (err) {
      setDrift(null);
      // A bare 500 carries only the code string; show readable copy instead.
      const msg =
        err instanceof DashboardApiError && err.message && err.message !== "internal_error"
          ? err.message
          : "The comparison could not run. Try again shortly.";
      setDriftError(msg);
    } finally {
      setDriftBusy(false);
    }
  }, []);

  if (!status) {
    return (
      <div className="cd-screen cd-screen--wide">
        <header className="cd-screen-head" data-screen-label="Go live">
          <h1 className="cd-h1">Go live</h1>
        </header>
        <SettingsSubTabs app={app} />
        <Card>
          <p className="cd-caption">Checking your store's cutover status…</p>
        </Card>
      </div>
    );
  }

  const meta = MODE_META[status.mode];
  const currentIdx = MODE_ORDER.indexOf(status.mode);
  const failing = status.gates.checks.filter((c) => !c.pass);

  return (
    <div className="cd-screen cd-screen--wide">
      <header className="cd-screen-head" data-screen-label="Go live">
        <div>
          <h1 className="cd-h1">Go live</h1>
        </div>
      </header>

      <SettingsSubTabs app={app} />

      <Card>
        <SectionTitle>Where you are</SectionTitle>
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          {MODE_ORDER.map((m, i) => (
            <div
              key={m}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                opacity: i <= currentIdx ? 1 : 0.45,
                fontWeight: m === status.mode ? 650 : 450,
              }}
              className="cd-caption"
            >
              {i > 0 && <CDIcon name="chevronRight" size={13} strokeWidth={2} />}
              <span>{MODE_META[m].title}</span>
            </div>
          ))}
        </div>
        <p className="cd-caption" style={{ marginTop: 10 }}>
          {meta.blurb}
        </p>

        <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
          {status.allowed.map((to) => {
            const m = MOVES[`${status.mode}->${to}`];
            if (!m) return null;
            const goLive = to === "live";
            return (
              <button
                key={to}
                type="button"
                className={`cd-btn ${m.primary ? "cd-btn-primary" : "cd-btn-secondary"}`}
                onClick={() => move(to)}
                disabled={busy || (goLive && !status.gates.pass)}
              >
                {goLive && <CDIcon name="rocket" size={16} strokeWidth={1.9} />}
                <span>{armed === to ? "Click again to confirm" : m.label}</span>
              </button>
            );
          })}
        </div>
        {status.mode === "dual_run" && !status.gates.pass && (
          <p className="cd-caption" style={{ marginTop: 10 }}>
            Going live unlocks when every item on the checklist below passes.
          </p>
        )}
        {blocked && (
          <p className="cd-caption" style={{ marginTop: 10 }}>
            {blocked}
          </p>
        )}
      </Card>

      <Card>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <SectionTitle>Go-live checklist</SectionTitle>
          <button
            type="button"
            className="cd-btn cd-btn-secondary cd-btn-sm"
            onClick={load}
            disabled={busy}
          >
            <CDIcon name="rotate" size={14} strokeWidth={1.9} />
            <span>Re-check</span>
          </button>
        </div>
        <p className="cd-caption" style={{ margin: "8px 0 4px" }}>
          {status.gates.pass
            ? "Everything checks out. Your store is ready to go live."
            : `${failing.length} item${failing.length === 1 ? "" : "s"} still need${failing.length === 1 ? "s" : ""} attention.`}
        </p>
        {probe && (
          <p
            className="cd-caption"
            style={{ display: "flex", alignItems: "flex-start", gap: 8, margin: "4px 0 0" }}
          >
            <CDIcon
              name={PROBE_NOTE[probe].icon}
              size={14}
              strokeWidth={2}
              style={{ marginTop: 1, flexShrink: 0 }}
            />
            <span>{PROBE_NOTE[probe].text}</span>
          </p>
        )}
        <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
          {status.gates.checks.map((c) => (
            <li
              key={c.name}
              className="cd-caption"
              style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 0" }}
            >
              <CDIcon
                name={c.pass ? "check" : "x"}
                size={15}
                strokeWidth={2.2}
                style={{ marginTop: 1, flexShrink: 0 }}
              />
              <span>
                {c.label}
                {!c.pass && (
                  <span style={{ opacity: 0.7 }}>
                    {" "}
                    (needs {c.expected}, found {c.actual})
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
        {status.mode === "dual_run" && !status.gates.paymentCleared && (
          <div style={{ marginTop: 14 }}>
            <button
              type="button"
              className="cd-btn cd-btn-secondary"
              onClick={runTestTransaction}
              disabled={testBusy}
            >
              <span>{testBusy ? "Starting…" : "Run a test transaction"}</span>
            </button>
            <p className="cd-caption" style={{ marginTop: 8 }}>
              Takes you to a secure Stripe checkout for a 50¢ charge to prove your payment
              setup, then brings you back here. It's automatically refunded when you go
              live.
            </p>
            {testError && (
              <p className="cd-caption" style={{ marginTop: 8 }}>
                {testError}
              </p>
            )}
          </div>
        )}
      </Card>

      {status.mode === "dual_run" && (
        <Card>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <SectionTitle>Does everything still match?</SectionTitle>
            <button
              type="button"
              className="cd-btn cd-btn-secondary cd-btn-sm"
              onClick={runDrift}
              disabled={driftBusy}
            >
              <CDIcon name="rotate" size={14} strokeWidth={1.9} />
              <span>{driftBusy ? "Comparing…" : "Compare with Shopify"}</span>
            </button>
          </div>
          <p className="cd-caption" style={{ margin: "8px 0 0" }}>
            Changes made directly in Shopify admin do not flow into Calderyn during dual run.
            This compares your live Shopify prices and stock with Calderyn's copy so you can
            fix any differences before you go live. Going live runs this same comparison and
            is blocked until everything matches.
          </p>
          {driftError && (
            <p className="cd-caption" style={{ marginTop: 10 }}>
              {driftError}
            </p>
          )}
          {drift &&
            (drift.pass ? (
              <p
                className="cd-caption"
                style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}
              >
                <CDIcon name="check" size={15} strokeWidth={2.2} />
                <span>
                  Everything matches. {drift.variantsChecked} item
                  {drift.variantsChecked === 1 ? "" : "s"} compared.
                </span>
              </p>
            ) : (
              <div style={{ marginTop: 4 }}>
                <DriftList
                  title="Prices that differ"
                  count={drift.price.count}
                  rows={drift.price.rows}
                  format={money}
                />
                <DriftList
                  title="Stock levels that differ"
                  count={drift.stock.count}
                  rows={drift.stock.rows}
                  format={(n) => `${n} in stock`}
                />
                {drift.shopifyOnly.count > 0 && (
                  <p className="cd-caption" style={{ marginTop: 10 }}>
                    {drift.shopifyOnly.count} item
                    {drift.shopifyOnly.count === 1 ? " exists" : "s exist"} only in Shopify
                    (added after your import): {drift.shopifyOnly.sample.join("; ")}
                    {drift.shopifyOnly.count > drift.shopifyOnly.sample.length ? "; and more" : ""}
                  </p>
                )}
                {drift.ownedOnly.count > 0 && (
                  <p className="cd-caption" style={{ marginTop: 10 }}>
                    {drift.ownedOnly.count} item
                    {drift.ownedOnly.count === 1 ? " is" : "s are"} still in Calderyn but no
                    longer in Shopify (removed after your import):{" "}
                    {drift.ownedOnly.sample.join("; ")}
                    {drift.ownedOnly.count > drift.ownedOnly.sample.length ? "; and more" : ""}
                  </p>
                )}
                {drift.truncated.count > 0 && (
                  <p className="cd-caption" style={{ marginTop: 10 }}>
                    {drift.truncated.count} product
                    {drift.truncated.count === 1 ? " has" : "s have"} too many variants or
                    stock locations to fully check: {drift.truncated.sample.join("; ")}
                    {drift.truncated.count > drift.truncated.sample.length ? "; and more" : ""}
                  </p>
                )}
                {drift.unmatchedLocations > 0 && (
                  <p className="cd-caption" style={{ marginTop: 10 }}>
                    {drift.unmatchedLocations} stock level
                    {drift.unmatchedLocations === 1 ? " is" : "s are"} at Shopify locations
                    Calderyn does not know about.
                  </p>
                )}
                <p className="cd-caption" style={{ opacity: 0.7, marginTop: 10 }}>
                  A checkout that is still in progress can show a small stock difference.
                  Re-run the comparison if a difference looks temporary.
                </p>
              </div>
            ))}
        </Card>
      )}
    </div>
  );
}
