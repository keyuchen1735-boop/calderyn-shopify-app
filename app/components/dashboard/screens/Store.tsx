import DesignerStudio, { DESIGNER_STATE_CACHE_KEY } from "./DesignerStudio";
import { fetchDesignerState } from "~/lib/designer/client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Btn, Placeholder } from "../ui";
import {
  DashboardApiError,
  fetchImportStatus,
  IMPORT_IN_PROGRESS,
  saveProduct,
  uploadCampaignCreativeImage as uploadOwnedImage,
  type ImportRunVM,
} from "~/lib/dashboard/client";
import { fetchStore, sendStoreCommand, type StudioState } from "~/lib/dashboard/store-client";
import { cacheScreenData, cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import {
  STORE_COMMAND_LIMITS,
  type StoreAttachment,
  type StoreCommand,
  type StoreCommandEvent,
  type StoreCommandReceipt,
} from "~/lib/storefront-command/types";
import {
  decideWelcomeBranch,
  missingPieces,
  parseProductLine,
  shouldShowWelcome,
  showPromptCanvas,
  type BuildPhase,
  type MerchantStage,
  type MissingPiece,
} from "./store-logic";
import type { DashboardCtx } from "../context";
import ChatRail from "../store/ChatRail";
import TopBar, { type Device } from "../store/TopBar";
import WelcomeOverlay from "../store/WelcomeOverlay";
import type { ChatMsg } from "../store/chat-types";
import type { PageKey } from "~/lib/storebuilder/types";

const PREVIEW_PATH = "/dashboard/store/preview";
const DESKTOP_PREVIEW_WIDTH = 1_024;
const MERCHANT_STAGES = new Set<MerchantStage>(["understanding", "preparing_products", "checking_preview"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

interface StagedStoreAttachment {
  id: string;
  name: string;
  previewUrl?: string;
  command: StoreAttachment;
}

export function applyStoreReceipt(state: StudioState, receipt: StoreCommandReceipt): StudioState {
  if (receipt.status === "installed") {
    return {
      ...state,
      hasDraft: true,
      release: { ...state.release, draftVersionId: receipt.versionId, draftRuntime: 1 },
    };
  }
  if (receipt.status === "published") {
    return {
      ...state,
      hasPublished: true,
      release: { ...state.release, publishedVersionId: receipt.versionId, publishedRuntime: 1 },
    };
  }
  return state;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

// After a dropped stream, how long to keep checking whether the server-side
// build actually finished (it usually did — long generations outlive flaky
// connections). Exported for tests.
export const RECOVERY_POLL_MS = 5_000;
export const RECOVERY_POLL_LIMIT = 60;
const RECOVERY_IDLE_TICKS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function Store({ app }: { app: DashboardCtx }) {
  // Hidden designer engine (sparkle in Settings): when it's on, the Store tab
  // IS the designer studio; the classic builder below stays untouched.
  const [designerEnabled, setDesignerEnabled] = useState<boolean>(
    () => cachedScreenData<{ enabled?: boolean }>(DESIGNER_STATE_CACHE_KEY)?.enabled === true,
  );
  useEffect(() => {
    let alive = true;
    fetchDesignerState()
      .then((state) => {
        if (!alive) return;
        cacheScreenData(DESIGNER_STATE_CACHE_KEY, state);
        setDesignerEnabled(state.enabled);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (designerEnabled) return <DesignerStudio app={app} />;
  return <ClassicStore app={app} />;
}

function ClassicStore({ app }: { app: DashboardCtx }) {
  const toast = app.toast;
  const [data, setData] = useState<StudioState | null>(() => cachedScreenData<StudioState>(SCREEN_CACHE_KEYS.storeStudio));
  const dataRef = useRef(data);
  const [loading, setLoading] = useState(true);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const setSnapshot = useCallback((snapshot: StudioState) => {
    dataRef.current = snapshot;
    cacheScreenData(SCREEN_CACHE_KEYS.storeStudio, snapshot);
    if (aliveRef.current) setData(snapshot);
  }, []);
  const refresh = useCallback(async () => {
    const snapshot = await fetchStore();
    setSnapshot(snapshot);
    return snapshot;
  }, [setSnapshot]);

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const messageSequence = useRef(0);
  const nextMessageId = () => {
    messageSequence.current += 1;
    return messageSequence.current;
  };
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<StagedStoreAttachment[]>([]);
  const attachmentSequence = useRef(0);
  const [attaching, setAttaching] = useState(false);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [buildPhase, setBuildPhase] = useState<BuildPhase | null>(null);
  const commandControllerRef = useRef<AbortController | null>(null);
  const [stoppable, setStoppable] = useState(false);
  useEffect(() => () => commandControllerRef.current?.abort(), []);

  const [previewVersion, setPreviewVersion] = useState(0);
  const [desktopPreviewScale, setDesktopPreviewScale] = useState(1);
  const previewWrapRef = useRef<HTMLDivElement>(null);
  const reloadPreview = useCallback(() => setPreviewVersion((version) => version + 1), []);

  useEffect(() => {
    const wrap = previewWrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    const resize = () => {
      if (wrap.clientWidth > 0) setDesktopPreviewScale(Math.min(1, wrap.clientWidth / DESKTOP_PREVIEW_WIDTH));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    resize();
    return () => observer.disconnect();
  }, [data]);
  const [page, setPage] = useState<PageKey>("home");
  const [device, setDevice] = useState<Device>("desktop");
  const badgeRef = useRef<HTMLSpanElement>(null);

  const [publishing, setPublishing] = useState(false);
  const [confirmingPublish, setConfirmingPublish] = useState(false);

  const freshLoadedRef = useRef(false);
  const [welcomeVisible, setWelcomeVisible] = useState(false);
  const [welcomeTerminalMessage, setWelcomeTerminalMessage] = useState<string | null>(null);
  const [importRun, setImportRun] = useState<ImportRunVM | null>(null);
  const porting = importRun != null && IMPORT_IN_PROGRESS.has(importRun.state);

  useEffect(() => {
    setLoading(true);
    refresh()
      .then((snapshot) => {
        if (!freshLoadedRef.current) {
          freshLoadedRef.current = true;
          if (shouldShowWelcome(snapshot)) setWelcomeVisible(true);
        }
      })
      .catch((error: unknown) => {
        if (aliveRef.current) toast(error instanceof DashboardApiError ? error.message : "Could not load your store.", "warn", "critical");
      })
      .finally(() => {
        if (aliveRef.current) setLoading(false);
      });
  }, [refresh, toast]);

  useEffect(() => {
    if (welcomeVisible && data && !shouldShowWelcome(data)) setWelcomeVisible(false);
  }, [data, welcomeVisible]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sawRun = false;
    let failures = 0;
    const tick = async () => {
      try {
        const run = await fetchImportStatus();
        failures = 0;
        if (!alive) return;
        setImportRun(run);
        if (run && IMPORT_IN_PROGRESS.has(run.state)) {
          sawRun = true;
          timer = setTimeout(() => void tick(), 3_000);
        } else if (sawRun && run?.state === "done") {
          toast("Your Shopify data is in", "download");
          void refresh().then(reloadPreview).catch(() => undefined);
        } else if (sawRun && run?.state === "error") {
          toast("Import didn't finish. Retry from Settings → Import.", "warn", "critical");
        }
      } catch {
        if (!alive) return;
        failures += 1;
        if (failures <= 5) timer = setTimeout(() => void tick(), 3_000);
        else setImportRun(null);
      }
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [refresh, reloadPreview, toast]);

  const replaceMessage = (id: number, message: ChatMsg) => {
    setMessages((current) => current.map((candidate) => candidate.id === id ? message : candidate));
  };

  const executeCommand = async (
    command: StoreCommand,
    userText: string,
    failedAttachments: StagedStoreAttachment[] = [],
  ): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setPublishing(command.kind === "publish");
    const controller = new AbortController();
    commandControllerRef.current = controller;
    setStoppable(command.kind === "prompt");
    const userId = nextMessageId();
    const workingId = nextMessageId();
    const phase: BuildPhase = { kind: "running" };
    setWelcomeTerminalMessage(null);
    setBuildPhase(phase);
    setMessages((current) => [
      ...current,
      { id: userId, kind: "user-text", text: userText },
      { id: workingId, kind: "ai-working", phase },
    ]);

    const onEvent = (event: StoreCommandEvent) => {
      if (!MERCHANT_STAGES.has(event.stage as MerchantStage) || !aliveRef.current) return;
      const nextPhase: BuildPhase = { kind: "running", stage: event.stage as MerchantStage };
      setBuildPhase(nextPhase);
      replaceMessage(workingId, { id: workingId, kind: "ai-working", phase: nextPhase });
    };

    try {
      const receipt = await sendStoreCommand(command, onEvent, controller.signal);
      if (!aliveRef.current) return;
      if (receipt.status === "installed") {
        const current = dataRef.current;
        if (current) setSnapshot(applyStoreReceipt(current, receipt));
        setWelcomeVisible(false);
        reloadPreview();
        replaceMessage(workingId, {
          id: workingId,
          kind: "ai-text",
          text: "Done. The change is in your preview.",
          actions: receipt.undo ? [{
            label: "Undo",
            onClick: () => void executeCommand({ kind: "undo", ...receipt.undo! }, "Undo"),
          }] : undefined,
        });
        setBuildPhase(null);
        try {
          await refresh();
        } catch {
          toast("The preview changed, but the latest store details could not be refreshed.", "warn");
        }
      } else if (receipt.status === "published") {
        const current = dataRef.current;
        if (current) setSnapshot(applyStoreReceipt(current, receipt));
        replaceMessage(workingId, { id: workingId, kind: "ai-text", text: "Published. Opening your storefront." });
        setBuildPhase(null);
        window.location.assign(dataRef.current?.storefrontUrl ?? "/storefront");
      } else {
        replaceMessage(workingId, { id: workingId, kind: "ai-text", text: receipt.message });
        setWelcomeTerminalMessage(receipt.message);
        setBuildPhase(null);
      }
    } catch (error) {
      if (!aliveRef.current) return;
      if (failedAttachments.length > 0) setAttachments(failedAttachments);
      if (isAbort(error) || controller.signal.aborted) {
        const message = "Stopped. Check the preview before sending another change.";
        try {
          await refresh();
          reloadPreview();
        } catch {
          // The neutral message remains truthful when reconciliation is unavailable.
        }
        replaceMessage(workingId, { id: workingId, kind: "ai-text", text: message });
        setWelcomeTerminalMessage(message);
      } else {
        // A dropped connection surfaces here as a failure even though the
        // server-side build usually keeps going and lands the draft. Before
        // declaring failure on a prompt, watch the store for a while: a new
        // draft version (or the in-flight generation flag) means the work is
        // real, and the merchant should see success, not a scary error.
        let recovered = false;
        // Only when the transport failed (no structured server reply): a
        // DashboardApiError is the server's definitive verdict and polling
        // would just delay showing it.
        if (command.kind === "prompt" && !(error instanceof DashboardApiError)) {
          setStoppable(false);
          const waitingText = "The connection hiccuped while I was working. Checking whether your change finished…";
          replaceMessage(workingId, { id: workingId, kind: "ai-text", text: waitingText });
          setWelcomeTerminalMessage(waitingText);
          const before = command.expectedDraftVersionId ?? null;
          let idleTicks = 0;
          for (let i = 0; i < RECOVERY_POLL_LIMIT && aliveRef.current; i += 1) {
            await sleep(RECOVERY_POLL_MS);
            if (!aliveRef.current) break;
            try {
              const snapshot = await fetchStore();
              setSnapshot(snapshot);
              if (snapshot.release.draftVersionId != null && snapshot.release.draftVersionId !== before) {
                recovered = true;
                break;
              }
              if (snapshot.generation) {
                idleTicks = 0;
              } else {
                idleTicks += 1;
                if (idleTicks >= RECOVERY_IDLE_TICKS) break;
              }
            } catch {
              // Offline; keep waiting — the next poll may reach the server.
            }
          }
        }
        if (recovered) {
          setWelcomeVisible(false);
          reloadPreview();
          replaceMessage(workingId, { id: workingId, kind: "ai-text", text: "Done. The change is in your preview." });
          setWelcomeTerminalMessage(null);
        } else {
          const message = error instanceof DashboardApiError ? error.message : "The storefront change could not be completed.";
          replaceMessage(workingId, { id: workingId, kind: "ai-text", text: message });
          setWelcomeTerminalMessage(message);
          if (error instanceof DashboardApiError && error.code === "storefront_command_conflict") {
            try { await refresh(); reloadPreview(); } catch { /* The original conflict remains the useful error. */ }
          }
        }
      }
      setBuildPhase(null);
    } finally {
      if (commandControllerRef.current === controller) commandControllerRef.current = null;
      busyRef.current = false;
      if (aliveRef.current) {
        setBusy(false);
        setPublishing(false);
        setStoppable(false);
      }
    }
  };

  const runPrompt = (text: string, userText = text, stagedAttachments: StagedStoreAttachment[] = []) => {
    const normalized = text.trim();
    if (!normalized) return;
    const commandAttachments = stagedAttachments.map(({ command }) => command);
    void executeCommand({
      kind: "prompt",
      prompt: normalized,
      expectedDraftVersionId: dataRef.current?.release.draftVersionId ?? null,
      ...(commandAttachments.length > 0 ? { attachments: commandAttachments } : {}),
    }, userText, stagedAttachments);
  };

  const onComposerSend = () => {
    const text = prompt.trim();
    if (!text || busyRef.current || attaching) return;
    const staged = attachments;
    setPrompt("");
    setAttachments([]);
    runPrompt(text, text, staged);
  };

  const onAttachFiles = async (files: File[]) => {
    if (attaching) return;
    setAttaching(true);
    let designReferenceCount = attachments
      .filter(({ command }) => command.kind === "design_reference").length;
    let hasShader = attachments.some(({ command }) => command.kind === "fragment_shader");
    let skippedForLimit = false;
    try {
      for (const file of files) {
        if (IMAGE_TYPES.has(file.type)) {
          if (designReferenceCount >= STORE_COMMAND_LIMITS.designReferences) {
            skippedForLimit = true;
            continue;
          }
          try {
            const uploaded = await uploadOwnedImage(file);
            attachmentSequence.current += 1;
            const addition = {
              id: String(attachmentSequence.current),
              name: file.name,
              previewUrl: uploaded.url,
              command: { kind: "design_reference" as const, assetRef: uploaded.assetRef },
            };
            designReferenceCount += 1;
            if (aliveRef.current) setAttachments((current) => [...current, addition]);
          } catch (error) {
            toast(error instanceof DashboardApiError ? error.message : "The attachment could not be prepared.", "warn", "critical");
          }
          continue;
        }
        if (!file.name.toLowerCase().endsWith(".frag")
          && !file.name.toLowerCase().endsWith(".glsl") && file.type !== "text/plain") {
          toast(`"${file.name}" is not a supported design reference or shader.`, "warn");
          continue;
        }
        if (hasShader) {
          skippedForLimit = true;
          continue;
        }
        try {
          const source = await file.text();
          if (!source.trim() || source.length > 4_000) {
            toast(`"${file.name}" must contain a shader of 4,000 characters or fewer.`, "warn");
            continue;
          }
          attachmentSequence.current += 1;
          const addition = {
            id: String(attachmentSequence.current),
            name: file.name,
            command: { kind: "fragment_shader" as const, source },
          };
          hasShader = true;
          if (aliveRef.current) setAttachments((current) => [...current, addition]);
        } catch (error) {
          toast(error instanceof DashboardApiError ? error.message : "The attachment could not be prepared.", "warn", "critical");
        }
      }
      if (skippedForLimit) toast("Attach up to four design references and one shader.", "warn");
    } finally {
      if (aliveRef.current) setAttaching(false);
    }
  };

  const onPublishClick = () => {
    const snapshot = dataRef.current;
    if (!snapshot?.release.draftVersionId || busyRef.current) return;
    const pieces = missingPieces(snapshot);
    if (pieces.length > 0) setConfirmingPublish(true);
    else void executeCommand({ kind: "publish", expectedDraftVersionId: snapshot.release.draftVersionId }, "Publish");
  };
  const publishAnyway = () => {
    const draftVersionId = dataRef.current?.release.draftVersionId;
    if (!draftVersionId) return;
    setConfirmingPublish(false);
    void executeCommand({ kind: "publish", expectedDraftVersionId: draftVersionId }, "Publish");
  };

  const onWelcomeAddProduct = async (line: string) => {
    const parsed = parseProductLine(line);
    const active = parsed.priceCents != null;
    try {
      await saveProduct({
        title: parsed.title,
        status: active ? "active" : "draft",
        variants: [active
          ? { retailPriceCents: parsed.priceCents ?? undefined, weightGrams: 500, lengthMm: 200, widthMm: 150, heightMm: 100 }
          : { retailPriceCents: parsed.priceCents ?? undefined }],
      });
      toast(active
        ? `"${parsed.title}" added with standard parcel shipping defaults; adjust in Products.`
        : `Draft product "${parsed.title}" created.`);
      await refresh();
      runPrompt("Build my store");
    } catch (error) {
      toast(error instanceof DashboardApiError ? error.message : "Couldn't create that product.", "warn", "critical");
    }
  };

  if (!data) {
    return (
      <div className="cd-screen cd-screen-storefront" data-screen-label="Store">
        <div className="cd-studio">
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Placeholder
              icon="store"
              title={loading ? "Loading your store" : "Store unavailable"}
              sub={loading ? "Reading your storefront." : "Could not load the studio just now. Refresh to try again."}
            />
          </div>
        </div>
      </div>
    );
  }

  const building = buildPhase?.kind === "running";
  const branch = decideWelcomeBranch({
    shopDomain: app.shopDomain,
    productCount: data.productCount,
    draftProductCount: data.draftProductCount,
    importInProgress: porting,
  });
  const previewRoute = page === "pdp" ? "product" : page === "collection" ? "collection" : "home";
  const previewSrc = `${PREVIEW_PATH}?route=${previewRoute}&page=${page}&v=${previewVersion}`;
  const promptCanvas = showPromptCanvas(data);
  const publishPieces: MissingPiece[] = missingPieces(data);

  return (
    <div className="cd-screen cd-screen-storefront" data-screen-label="Store">
      <div className="cd-studio">
        <ChatRail
          messages={messages}
          prompt={prompt}
          onPromptChange={setPrompt}
          onSend={onComposerSend}
          onStop={() => commandControllerRef.current?.abort(new DOMException("Stopped", "AbortError"))}
          busy={busy}
          stoppable={stoppable}
          attaching={attaching}
          attachments={attachments.map(({ id, name, previewUrl }) => ({ id, name, ...(previewUrl ? { previewUrl } : {}) }))}
          onAttachFiles={(files) => { void onAttachFiles(files); }}
          onRemoveAttachment={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))}
        />
        <div className="cd-stage">
          {promptCanvas ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Placeholder icon="sparkle" title="Prompt anything" sub="Tell Calderyn what to build and it appears here." />
            </div>
          ) : (
            <>
              <TopBar
                ref={badgeRef}
                storefrontUrl={data.storefrontUrl}
                onOpenStorefront={() => window.open(data.storefrontUrl, "_blank", "noopener")}
                hasPublished={data.hasPublished}
                building={building}
                page={page}
                onPageChange={setPage}
                device={device}
                onDeviceChange={setDevice}
                onPublish={onPublishClick}
                publishing={publishing}
                canPublish={data.release.draftVersionId != null}
              />
              <div className="cd-stage-page">
                <div ref={previewWrapRef} className="cd-canvas-frame-wrap" data-device={device}>
                  <iframe
                    key={previewSrc}
                    className="cd-canvas-frame"
                    data-fade="0"
                    onLoad={(e) => { e.currentTarget.dataset.fade = "1"; }}
                    title="Store preview"
                    src={previewSrc}
                    sandbox="allow-same-origin allow-scripts allow-popups"
                    style={device === "desktop" && desktopPreviewScale < 1 ? {
                      width: `${100 / desktopPreviewScale}%`,
                      height: `${100 / desktopPreviewScale}%`,
                      flex: "none",
                      transform: `scale(${desktopPreviewScale})`,
                      transformOrigin: "top left",
                    } : undefined}
                  />
                  <div className="cd-canvas-veil" data-on={building ? "1" : "0"} aria-hidden="true">
                    <div className="cd-canvas-skel" style={{ ["--cd-skel" as string]: data.settings.accent }}>
                      <div className="cd-canvas-skel__hero" />
                      <div className="cd-canvas-skel__row" />
                      <div className="cd-canvas-skel__row cd-canvas-skel__row--short" />
                      <div className="cd-canvas-skel__grid"><span /><span /><span /></div>
                    </div>
                  </div>
                  {confirmingPublish && publishPieces.length > 0 ? (
                    <div className="cd-build-float" role="alertdialog" aria-label="Before you publish">
                      <div className="cd-buildlist">
                        {publishPieces.map((piece) => (
                          <div key={piece.key} className="cd-build-step">
                            <span className="cd-build-dot" data-st="wait" style={{ background: "var(--orange)" }} />
                            <div>
                              <div className="cd-build-title">{piece.label}</div>
                              <button
                                type="button"
                                className="cd-chip"
                                style={{ marginTop: 6 }}
                                onClick={() => {
                                  setConfirmingPublish(false);
                                  app.navigate(piece.screen);
                                }}
                              >
                                {piece.action}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div style={{ display: "flex", gap: 8, padding: "0 18px 12px" }}>
                        <Btn kind="primary" small onClick={publishAnyway} disabled={publishing || building}>Publish anyway</Btn>
                        <Btn small onClick={() => setConfirmingPublish(false)}>Keep editing</Btn>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </div>
        {welcomeVisible ? (
          <WelcomeOverlay
            authBase={app.authBase}
            branch={branch}
            importRun={importRun}
            buildPhase={buildPhase}
            terminalMessage={welcomeTerminalMessage}
            productCount={data.productCount}
            onBuildPrompt={runPrompt}
            onAddProduct={(line) => void onWelcomeAddProduct(line)}
          />
        ) : null}
      </div>
    </div>
  );
}
