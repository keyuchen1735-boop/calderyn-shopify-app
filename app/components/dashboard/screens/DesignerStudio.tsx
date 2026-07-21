// The hidden designer studio (sparkle engine): full-bleed preview with the
// floating bottom dock. Self-contained on purpose — the classic Store screen
// mounts it behind a two-line branch, so builder rewrites can't silently
// take the secret surface with them again.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DashboardApiError } from "~/lib/dashboard/client";
import { fetchDesignerState, publishDesignerSite, type DesignerStateVM } from "~/lib/designer/client";
import { readDesignerState, reconcileDesignerState } from "~/lib/designer/state";
import { DESIGNER_PAGE_LABELS } from "~/lib/designer/context";
import type { StudioDesignModel } from "~/lib/storebuilder/studio-types";
import {
  designerNewId,
  getDesignerSession,
  pushDesignerMsg,
  runDesignerTurn,
  seedDesignerMessages,
  subscribeDesignerSession,
} from "~/lib/designer/session";
import type { DashboardCtx } from "../context";
import DesignerDock from "../store/DesignerDock";
import type { ChatMsg } from "../store/chat-types";
import { Btn } from "../ui";

export { DESIGNER_STATE_CACHE_KEY } from "~/lib/designer/state";

type DesignerPageKey = "home" | "collection" | "product" | "search" | "cart" | "checkout";
// Shared with the edit-result card so the picker and the card name pages
// identically.
const PAGES: { key: DesignerPageKey; label: string }[] = (
  ["home", "collection", "product", "search", "cart", "checkout"] as const
).map((key) => ({ key, label: DESIGNER_PAGE_LABELS[key] }));

export default function DesignerStudio({ app }: { app: DashboardCtx }) {
  const toast = app.toast;
  const [state, setState] = useState<DesignerStateVM | null>(() => readDesignerState());
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // The chat session lives OUTSIDE this screen (module singleton) so a
  // running build keeps streaming while the merchant explores other tabs;
  // remounting simply re-attaches to whatever is in flight.
  const session = useSyncExternalStore(subscribeDesignerSession, getDesignerSession, getDesignerSession);
  const messages = session.messages;
  const busy = session.busy;
  const newId = designerNewId;
  const pushMsg = useCallback((msg: ChatMsg) => pushDesignerMsg(msg), []);
  const [prompt, setPrompt] = useState("");
  const [publishing, setPublishing] = useState(false);
  const publishingRef = useRef(false);
  const [model, setModel] = useState<StudioDesignModel>("sonnet");
  const [mode, setMode] = useState<"template" | "scratch">("template");
  const [page, setPage] = useState<DesignerPageKey>("home");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const previewVersion = session.previewVersion;

  const refresh = useCallback(async () => {
    try {
      // Reconciled against any in-flight sparkle toggle so a stale read
      // can't flip the cached engine choice back (see ~/lib/designer/state).
      const next = reconcileDesignerState(await fetchDesignerState());
      if (!aliveRef.current) return;
      setState(next);
      // Reload recovery: the session seeds from the saved chat exactly once,
      // and never over a thread with live messages.
      seedDesignerMessages(next.chat);
    } catch {
      // Cached state (or the fresh-build default) keeps the studio usable.
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ready = state?.ready === true;

  const onSend = () => {
    if (busy) return;
    const text = prompt.trim();
    if (!text) return;
    setPrompt("");
    pushMsg({ id: newId(), kind: "user-text", text });
    runDesignerTurn({
      message: text,
      page,
      model,
      mode,
      firstBuild: !ready,
      onSettled: () => {
        if (!ready && aliveRef.current) void refresh();
      },
    });
  };

  const onPublish = async () => {
    if (publishingRef.current) return;
    publishingRef.current = true;
    setPublishing(true);
    try {
      const { storefrontUrl } = await publishDesignerSite();
      if (!aliveRef.current) return;
      toast("Your site is live", "check");
      pushMsg({
        id: newId(),
        kind: "ai-text",
        text: "Published. Your latest design is live on your site.",
        actions: [{ label: "Visit your site", kind: "primary", onClick: () => window.open(storefrontUrl, "_blank", "noopener") }],
      });
    } catch (err) {
      if (!aliveRef.current) return;
      toast(err instanceof DashboardApiError ? err.message : "Could not publish.", "warn", "critical");
    } finally {
      publishingRef.current = false;
      if (aliveRef.current) setPublishing(false);
    }
  };

  return (
    <div className="cd-screen cd-screen-storefront" data-screen-label="Store">
      <div className="cd-studio" data-dock="1">
        <div className="cd-stage">
          <div className="cd-studio-bar">
            <b style={{ fontSize: "calc(14px * var(--type-scale))", letterSpacing: "-0.012em" }}>Build with Calderyn</b>
            <span className="cd-chip" aria-hidden="true">Designer beta</span>
            <span style={{ flex: 1 }} />
            <select
              className="cd-composer-model"
              aria-label="Page"
              value={page}
              onChange={(e) => setPage(e.target.value as DesignerPageKey)}
            >
              {PAGES.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
            {(["desktop", "mobile"] as const).map((d) => (
              <button
                key={d}
                type="button"
                className="cd-chip"
                aria-pressed={device === d}
                style={device === d ? { borderColor: "var(--cd-accent, #6366f1)", fontWeight: 600 } : undefined}
                onClick={() => setDevice(d)}
              >
                {d === "desktop" ? "Desktop" : "Mobile"}
              </button>
            ))}
            <Btn kind="primary" small onClick={() => void onPublish()} disabled={publishing || !ready}>
              {publishing ? "Publishing…" : "Publish"}
            </Btn>
          </div>

          <div className="cd-stage-page">
            <div className="cd-canvas-frame-wrap" data-device={device}>
              <iframe
                key="designer-preview"
                className="cd-canvas-frame"
                title="Store preview"
                src={`/dashboard/designer/preview?page=${page}&v=${previewVersion}`}
                // Designer documents are AI-edited markup: scripts stay off in
                // the sandbox on top of the preview's no-script CSP.
                sandbox="allow-same-origin"
              />
            </div>
          </div>

          <DesignerDock
            messages={messages}
            prompt={prompt}
            onPromptChange={setPrompt}
            onSend={onSend}
            onStop={() => {}}
            busy={busy}
            busySince={session.busySince}
            stoppable={false}
            attaching={false}
            onAttachFiles={() => toast("Image attachments aren't supported in the designer beta yet.", "warn")}
            // Answer on click, before a file picker that could go nowhere.
            onAttachClick={() => toast("Image attachments aren't supported in the designer beta yet.", "warn")}
            model={model}
            onModelChange={setModel}
            placeholder={!ready ? "Describe your store and Calderyn builds every page…" : undefined}
            composerExtra={
              !ready ? (
                <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "0 2px 8px" }}>
                  <span className="cd-caption" style={{ marginRight: 2 }}>Start from</span>
                  {(["template", "scratch"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className="cd-chip"
                      aria-pressed={mode === m}
                      style={mode === m ? { borderColor: "var(--cd-accent, #6366f1)", fontWeight: 600 } : undefined}
                      onClick={() => setMode(m)}
                    >
                      {m === "template" ? "A template" : "Scratch"}
                    </button>
                  ))}
                </div>
              ) : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
