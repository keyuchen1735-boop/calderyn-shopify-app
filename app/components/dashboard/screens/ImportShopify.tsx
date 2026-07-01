import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardCtx } from "../context";
import { Card, SectionTitle } from "../ui";
import { CDIcon } from "../icons";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";

const IN_PROGRESS = new Set(["pulling", "promoting"]);

// Import from Shopify (#13.promote): a one-click, re-runnable migration that pulls the last
// 12 months of the merchant's Shopify store into Calderyn's owned tables. Starts a background
// run and polls it to completion, then shows an honest report of what was (and wasn't) imported.
export default function ImportShopify({ app }: { app: DashboardCtx }) {
  const [run, setRun] = useState<client.ImportRunVM | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      setRun(await client.fetchImportStatus());
    } catch {
      /* transient poll failure — keep the last known state */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll only while a run is in progress; stop at a terminal state / on unmount.
  useEffect(() => {
    const running = !!run && IN_PROGRESS.has(run.state);
    if (running && !timer.current) {
      timer.current = setInterval(load, 3000);
    } else if (!running && timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    return () => {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [run, load]);

  const start = useCallback(async () => {
    setStarting(true);
    try {
      await client.startShopifyImport();
      app.toast("Import started — pulling your Shopify data.", "download");
      await load();
    } catch (err) {
      app.toast(
        err instanceof DashboardApiError ? err.message : "Couldn't start the import.",
        "warn",
        "critical",
      );
    } finally {
      setStarting(false);
    }
  }, [app, load]);

  // Owned-only shop (no Shopify connection) — there is nothing to import from yet.
  if (!app.shopDomain) {
    return (
      <div className="cd-screen cd-screen--wide">
        <header className="cd-screen-head" data-screen-label="Import from Shopify">
          <h1 className="cd-h1">Import from Shopify</h1>
        </header>
        <Card>
          <p className="cd-caption">
            Connect your Shopify store first, then come back here to bring your products,
            collections, stock, and order history into Calderyn.
          </p>
          <a
            className="cd-btn cd-btn-primary"
            href="/dashboard/connect"
            style={{ marginTop: 12, display: "inline-flex" }}
          >
            Connect Shopify
          </a>
        </Card>
      </div>
    );
  }

  const running = !!run && IN_PROGRESS.has(run.state);
  const listStyle = { margin: "6px 0 0", paddingLeft: 18 } as const;

  return (
    <div className="cd-screen cd-screen--wide">
      <header className="cd-screen-head" data-screen-label="Import from Shopify">
        <h1 className="cd-h1">Import from Shopify</h1>
      </header>

      <Card>
        <p className="cd-caption" style={{ marginBottom: 12 }}>
          Bring the last 12 months of your Shopify store into Calderyn — products, variants,
          collections, stock levels, and order history. You can run this again anytime; it never
          duplicates what is already here.
        </p>
        <button
          type="button"
          className="cd-btn cd-btn-primary"
          onClick={start}
          disabled={starting || running}
        >
          <CDIcon name="download" size={16} strokeWidth={1.9} />
          <span>
            {running
              ? "Import in progress…"
              : run?.state === "done"
                ? "Import again"
                : "Import from Shopify"}
          </span>
        </button>

        {running && (
          <p className="cd-caption" style={{ marginTop: 12 }}>
            {run?.state === "pulling"
              ? "Pulling your Shopify data… this can take a few minutes."
              : "Organizing your catalog and stock…"}
          </p>
        )}

        {run?.state === "error" && (
          <p className="cd-caption" style={{ marginTop: 12 }}>
            The last import did not finish: {run.error ?? "unknown error"}. You can try again.
          </p>
        )}
      </Card>

      {run?.state === "done" && run.report && (
        <Card>
          <SectionTitle>What we brought over</SectionTitle>
          <ul className="cd-caption" style={listStyle}>
            {run.report.imported.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div style={{ marginTop: 16 }}>
            <SectionTitle>Not included</SectionTitle>
            <ul className="cd-caption" style={listStyle}>
              {run.report.notIncluded.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </Card>
      )}
    </div>
  );
}
