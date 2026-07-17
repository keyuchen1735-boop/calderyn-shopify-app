// The hidden designer studio (sparkle engine): full-bleed preview with the
// floating bottom dock. Self-contained on purpose — the classic Store screen
// mounts it behind a two-line branch, so builder rewrites can't silently
// take the secret surface with them again.
import { useCallback, useEffect, useRef, useState } from "react";
import { DashboardApiError } from "~/lib/dashboard/client";
import { cachedScreenData, cacheScreenData } from "~/lib/dashboard/screen-cache";
import {
  fetchDesignerState,
  publishDesignerSite,
  sendDesignerMessage,
  type DesignerStateVM,
} from "~/lib/designer/client";
import type { StudioDesignModel } from "~/lib/storebuilder/studio-types";
import type { DashboardCtx } from "../context";
import DesignerDock from "../store/DesignerDock";
import type { ChatMsg } from "../store/chat-types";
import { Btn } from "../ui";

export const DESIGNER_STATE_CACHE_KEY = "designer-studio";

type DesignerPageKey = "home" | "collection" | "product" | "search" | "cart" | "checkout";
const PAGES: { key: DesignerPageKey; label: string }[] = [
  { key: "home", label: "Home page" },
  { key: "collection", label: "Collection" },
  { key: "product", label: "Product page" },
  { key: "search", label: "Search" },
  { key: "cart", label: "Cart" },
  { key: "checkout", label: "Checkout" },
];

export default function DesignerStudio({ app }: { app: DashboardCtx }) {
  const toast = app.toast;
  const [state, setState] = useState<DesignerStateVM | null>(() =>
    cachedScreenData<DesignerStateVM>(DESIGNER_STATE_CACHE_KEY),
  );
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const msgSeq = useRef(0);
  const newId = () => {
    msgSeq.current += 1;
    return msgSeq.current;
  };
  const pushMsg = useCallback((msg: ChatMsg) => setMessages((m) => [...m, msg]), []);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const setBusyBoth = (v: boolean) => {
    busyRef.current = v;
    setBusy(v);
  };
  const [publishing, setPublishing] = useState(false);
  const publishingRef = useRef(false);
  const [model, setModel] = useState<StudioDesignModel>("sonnet");
  const [mode, setMode] = useState<"template" | "scratch">("template");
  const [page, setPage] = useState<DesignerPageKey>("home");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [previewVersion, setPreviewVersion] = useState(0);
  const reloadPreview = () => setPreviewVersion((v) => v + 1);
  const seededRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchDesignerState();
      if (!aliveRef.current) return;
      cacheScreenData(DESIGNER_STATE_CACHE_KEY, next);
      setState(next);
      // Reload recovery: an empty local thread re-seeds from the saved chat so
      // the merchant keeps their history after a refresh.
      if (!seededRef.current) {
        seededRef.current = true;
        setMessages((current) =>
          current.length > 0
            ? current
            : next.chat.map((row) => ({
                id: newId(),
                kind: row.role === "user" ? ("user-text" as const) : ("ai-text" as const),
                text: row.body,
              })),
        );
      }
    } catch {
      // Cached state (or the fresh-build default) keeps the studio usable.
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ready = state?.ready === true;

  const runDesignerChat = async (text: string) => {
    if (busyRef.current) return;
    setBusyBoth(true);
    const firstBuild = !ready;
    const thinkId = newId();
    pushMsg({ id: thinkId, kind: "ai-thinking" });
    try {
      const turn = await sendDesignerMessage({
        message: text,
        page,
        model,
        ...(firstBuild ? { mode } : {}),
        onPage: (event) => {
          if (!aliveRef.current) return;
          setMessages((m) => {
            const without = m.filter((x) => x.id !== thinkId);
            return [
              ...without,
              { id: newId(), kind: "ai-text", text: `${event.reply} (${event.index}/${event.total} pages ready — it's in the preview.)` },
              { id: thinkId, kind: "ai-thinking" },
            ];
          });
          reloadPreview();
        },
      });
      if (!aliveRef.current) return;
      if (turn.changed) reloadPreview();
      setMessages((m) => m.filter((x) => x.id !== thinkId).concat({ id: newId(), kind: "ai-text", text: turn.reply }));
      if (firstBuild) void refresh();
    } catch (err) {
      if (!aliveRef.current) return;
      const msg = err instanceof DashboardApiError ? err.message : "Couldn't make that change. Try again.";
      setMessages((m) => m.filter((x) => x.id !== thinkId).concat({ id: newId(), kind: "ai-text", text: msg }));
      if (firstBuild) void refresh();
    } finally {
      if (aliveRef.current) setBusyBoth(false);
    }
  };

  const onSend = () => {
    if (busyRef.current) return;
    const text = prompt.trim();
    if (!text) return;
    setPrompt("");
    pushMsg({ id: newId(), kind: "user-text", text });
    void runDesignerChat(text);
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
            stoppable={false}
            attaching={false}
            onAttachFiles={() => toast("Image attachments aren't supported in the designer beta yet.", "warn")}
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
