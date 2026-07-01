import { useCallback, useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Card, SectionTitle } from "../ui";
import { CDIcon } from "../icons";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";

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

export default function Cutover({ app }: { app: DashboardCtx }) {
  const [status, setStatus] = useState<client.CutoverStatusVM | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<client.CutoverMode | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await client.fetchCutoverStatus());
    } catch {
      /* transient fetch failure; keep the last known state */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
        setStatus(await client.requestCutoverTransition(to));
        app.toast(
          to === "live" ? "Your store is live on Calderyn." : "Cutover step applied.",
          "rocket",
        );
      } catch (err) {
        const msg =
          err instanceof DashboardApiError ? err.message : "That step could not be applied.";
        setBlocked(msg);
        app.toast("That step is blocked. See the checklist below.", "warn", "critical");
        await load();
      } finally {
        setBusy(false);
      }
    },
    [app, armed, load, status],
  );

  if (!status) {
    return (
      <div className="cd-screen cd-screen--wide">
        <header className="cd-screen-head" data-screen-label="Go live">
          <h1 className="cd-h1">Go live</h1>
        </header>
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
        <h1 className="cd-h1">Go live</h1>
      </header>

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
      </Card>
    </div>
  );
}
