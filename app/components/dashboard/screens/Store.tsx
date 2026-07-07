import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Btn, Placeholder } from "../ui";
import {
  DashboardApiError,
  fetchImportStatus,
  IMPORT_IN_PROGRESS,
  saveProduct,
  type ImportRunVM,
} from "~/lib/dashboard/client";
import { cacheScreenData, cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import {
  addProductFromImage,
  decideStoreExperiment,
  fetchStudio,
  generateStudioStore,
  generateStudioStoreWithImages,
  publishStudioStore,
  saveStudioHero,
  setStudioAccent,
  setStudioVibe,
  startStoreExperiment,
  type StudioAddedProduct,
  type StudioDesignModel,
  type StudioGenerateReceipt,
  type StudioHero,
  type StudioState,
  type StudioVibe,
} from "~/lib/dashboard/store-client";
import {
  decideWelcomeBranch,
  isDeterministicChatIntent,
  missingPieces,
  parseChatIntent,
  parseProductLine,
  planStagedAttachments,
  shouldShowWelcome,
  showPromptCanvas,
  type BuildPhase,
  type ChatIntent,
  type MissingPiece,
} from "./store-logic";
import type { DashboardCtx } from "../context";
import ChatRail from "../store/ChatRail";
import TopBar, { type Device } from "../store/TopBar";
import WelcomeOverlay from "../store/WelcomeOverlay";
import { StoreSubTabs } from "../subtabs";
import { confettiFrom } from "../store/confetti";
import type { ChatAction, ChatMsg } from "../store/chat-types";
import type { PageKey } from "~/lib/storebuilder/types";

// The draft home document's default hero copy (app/lib/storebuilder/default-doc.ts) —
// the seed used before a real doc loads.
const DEFAULT_HERO: StudioHero = { headline: "Welcome", subhead: "Shop our latest" };

// The studio canvas is a same-origin iframe of the server-rendered draft store
// (see app/routes/dashboard.store.preview.tsx) — the ACTUAL generated
// BlockDocument with the real storefront styles. A version counter in the src
// forces a reload after every mutation.
const PREVIEW_PATH = "/dashboard/store/preview";

const PAGE_LABEL: Record<string, string> = { home: "home", pdp: "product", collection: "collection" };
const VIBE_LABEL: Record<StudioVibe, string> = { minimal: "clean, minimal", bold: "bold, dramatic", warm: "warm, earthy" };

const clampPct = (v: number): number => Math.min(100, Math.max(0, v));
function pctPoint(e: ReactPointerEvent<HTMLElement>): { x: number; y: number } {
  const rect = e.currentTarget.getBoundingClientRect();
  return {
    x: clampPct(((e.clientX - rect.left) / rect.width) * 100),
    y: clampPct(((e.clientY - rect.top) / rect.height) * 100),
  };
}

export default function Store({ app }: { app: DashboardCtx }) {
  const toast = app.toast;

  // Seeded from the session cache so a return visit paints instantly; the
  // mount refresh below revalidates and writes back through.
  const [data, setData] = useState<StudioState | null>(() =>
    cachedScreenData<StudioState>(SCREEN_CACHE_KEYS.storeStudio),
  );
  const [loading, setLoading] = useState(true);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // --- chat thread ----------------------------------------------------------
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const msgSeq = useRef(0);
  const newId = () => {
    msgSeq.current += 1;
    return msgSeq.current;
  };
  const pushMsg = useCallback((msg: ChatMsg) => setMessages((m) => [...m, msg]), []);
  const [prompt, setPrompt] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  // Chat action buttons (Undo, "Make it bolder"…) live inside `messages` and
  // can be clicked long after the render that created them, so the overlap
  // guard below must read a ref (always current) rather than the `chatBusy`
  // state closed over at creation time — the state itself only drives the
  // composer's disabled attribute, which is always rendered fresh.
  const chatBusyRef = useRef(false);
  const setChatBusyBoth = (v: boolean) => {
    chatBusyRef.current = v;
    setChatBusy(v);
  };
  const [attaching, setAttaching] = useState(false);
  // Ref-paired like chatBusy: the "Add as products" quick-reply lives inside a
  // chat message and can be clicked long after the render that created it, so
  // its overlap guard must read a ref, not the closed-over state.
  const attachingRef = useRef(false);
  const setAttachingBoth = (v: boolean) => {
    attachingRef.current = v;
    setAttaching(v);
  };
  const buildingRef = useRef(false);
  const [buildPhase, setBuildPhase] = useState<BuildPhase | null>(null);
  // Design-model picker. Ref-paired like chatBusy: builds fire from chat-action
  // closures created long before the click, so they must read the current pick.
  const [designModel, setDesignModel] = useState<StudioDesignModel>("sonnet");
  const designModelRef = useRef<StudioDesignModel>("sonnet");
  const setDesignModelBoth = (m: StudioDesignModel) => {
    designModelRef.current = m;
    setDesignModel(m);
  };

  // --- composer attachments (staged with the prompt) -------------------------
  // Images picked/dropped are STAGED as chips, not auto-converted; they travel
  // with the next send. Each carries an object URL for its thumbnail, revoked on
  // removal / send / unmount so a staging session leaks no blobs.
  const [attachments, setAttachments] = useState<{ id: string; file: File; url: string }[]>([]);
  const attachmentsRef = useRef<typeof attachments>([]);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  useEffect(
    () => () => {
      for (const a of attachmentsRef.current) URL.revokeObjectURL(a.url);
    },
    [],
  );

  // --- preview / canvas -------------------------------------------------------
  const [previewVersion, setPreviewVersion] = useState(0);
  const reloadPreview = useCallback(() => setPreviewVersion((v) => v + 1), []);
  const [page, setPage] = useState<PageKey>("home");
  const [device, setDevice] = useState<Device>("desktop");
  const badgeRef = useRef<HTMLSpanElement>(null);

  // --- markup (session-only strokes + note -> chat message) -----------------
  const [markupOn, setMarkupOn] = useState(false);
  const [strokes, setStrokes] = useState<string[]>([]);
  const drawing = useRef<string[] | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState("");

  // --- publish ----------------------------------------------------------------
  const [publishing, setPublishing] = useState(false);
  // Reached from the "Looks good, publish it" chip stored inside a chat
  // message (long-lived, unlike the TopBar's Publish button) — same
  // stale-closure concern as chatBusyRef above, so the guard reads a ref.
  const publishingRef = useRef(false);
  const setPublishingBoth = (v: boolean) => {
    publishingRef.current = v;
    setPublishing(v);
  };
  const [confirmingPublish, setConfirmingPublish] = useState(false);

  // --- experiments --------------------------------------------------------------
  const [decidingExperiment, setDecidingExperiment] = useState(false);

  // --- deterministic mutation ordering ------------------------------------------
  // Vibe/accent/hero edits and publish all race against the same store_settings
  // row and draft doc; queuing every deterministic edit onto one chain (mirrors
  // the old per-field heroSaveChain, generalized to all three) guarantees they
  // land in request order and that publish always sees the last one committed.
  const mutationChain = useRef<Promise<void>>(Promise.resolve());
  const queueMutation = <T,>(run: () => Promise<T>): Promise<T> => {
    const settled = mutationChain.current.then(run);
    mutationChain.current = settled.then(
      () => undefined,
      () => undefined,
    );
    return settled;
  };

  // --- welcome overlay ---------------------------------------------------------
  // Only evaluated after a FRESH fetch resolves — never against the cache seed,
  // which may be stale or belong to an already-built session.
  const freshLoadedRef = useRef(false);
  const [welcomeVisible, setWelcomeVisible] = useState(false);
  const [importRun, setImportRun] = useState<ImportRunVM | null>(null);
  const porting = importRun != null && IMPORT_IN_PROGRESS.has(importRun.state);

  const refresh = useCallback(async () => {
    const s = await fetchStudio();
    cacheScreenData(SCREEN_CACHE_KEYS.storeStudio, s);
    if (!aliveRef.current) return;
    setData(s);
    if (!freshLoadedRef.current) {
      freshLoadedRef.current = true;
      if (shouldShowWelcome(s)) setWelcomeVisible(true);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    refresh()
      .catch((err: unknown) => {
        if (!aliveRef.current) return;
        const msg = err instanceof DashboardApiError ? err.message : "Could not load your store.";
        toast(msg, "warn", "critical");
      })
      .finally(() => {
        if (aliveRef.current) setLoading(false);
      });
  }, [refresh, toast]);

  // A build/publish/import landing for real dismisses the overlay; it never
  // re-opens once dismissed just because data changed again.
  useEffect(() => {
    if (welcomeVisible && data && !shouldShowWelcome(data)) setWelcomeVisible(false);
  }, [data, welcomeVisible]);

  // Shopify port watcher: the OAuth callback auto-starts an import and lands
  // the merchant here, so the welcome overlay shows the pull streaming in with
  // real counts, then reloads once the run finishes. Polls only while a run is
  // in progress; a transient poll failure retries rather than killing the watch.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sawRun = false;
    let misses = 0;
    const tick = async () => {
      let run: ImportRunVM | null;
      try {
        run = await fetchImportStatus();
        misses = 0;
      } catch {
        if (!alive) return;
        misses += 1;
        if (misses <= 5) {
          timer = setTimeout(() => void tick(), 3000);
          return;
        }
        // 6th consecutive failure: stop polling and clear the run so the
        // derived porting state clears instead of sticking forever — a
        // reload restarts the watch (matches the old behavior's recovery path).
        setImportRun(null);
        return;
      }
      if (!alive) return;
      setImportRun(run);
      if (run && IMPORT_IN_PROGRESS.has(run.state)) {
        sawRun = true;
        timer = setTimeout(() => void tick(), 3000);
        return;
      }
      if (sawRun && run?.state === "done") {
        toast("Your Shopify data is in", "download");
        void refresh().then(reloadPreview).catch(() => {});
      } else if (sawRun && run?.state === "error") {
        toast("Import didn't finish. Retry from Settings → Import.", "warn", "critical");
      }
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [refresh, reloadPreview, toast]);

  // --- generate (chat and welcome both funnel through here) -------------------
  // The working-card message snapshots its OWN phase (updated only by this
  // call, via its own workingId) rather than reading the shared `buildPhase`
  // state — otherwise a later, unrelated build would flip an older, already-
  // finished card in the thread back to "running" (buildPhase is shared app-
  // wide for the TopBar badge / canvas veil / welcome overlay).
  // Flip a build's working card to a failed phase and post the message; the
  // shared error path for both the JSON and the multipart generate calls.
  const failBuild = (workingId: number, message: string, opts?: { toast?: boolean; actions?: ChatAction[] }) => {
    const failedPhase: BuildPhase = { kind: "failed", message };
    setBuildPhase(failedPhase);
    setMessages((m) => m.map((x) => (x.id === workingId ? { ...x, phase: failedPhase } : x)));
    pushMsg({ id: newId(), kind: "ai-text", text: message, actions: opts?.actions });
    if (opts?.toast) toast(message, "warn", "critical");
  };

  // Drop a transient working card when the outcome wasn't a generation at all
  // (needs_intent / products-only): the card said "Generating", but nothing was
  // — so remove it rather than flip it to a "done" that would misreport (rule 12).
  const clearBuildCard = (workingId: number) => {
    setBuildPhase(null);
    setMessages((m) => m.filter((x) => x.id !== workingId));
  };

  // Post-receipt handling for a generation that actually RAN (draft/no_products/
  // soft-degraded failed-with-runId). Shared by the JSON path and the multipart
  // reference/both paths; `extraLines` append the multipart-only notes (added
  // drafts, unread references) to the same completion message.
  const settleGeneration = (
    workingId: number,
    status: "draft" | "no_products" | "failed",
    opts?: { firstBuild?: boolean; extraLines?: string[] },
  ) => {
    const donePhase: BuildPhase = { kind: "done", status };
    setBuildPhase(donePhase);
    setMessages((m) => m.map((x) => (x.id === workingId ? { ...x, phase: donePhase } : x)));
    const base =
      status === "failed"
        ? // Honest failure (rule 12): the AI designer was unreachable, so this
          // is a deterministic starter layout, not the prompted design.
          "The AI designer is unavailable right now, so I used a starter layout instead of your prompt. Add Anthropic credits and try Build again."
        : opts?.firstBuild
          ? "Here's your first draft: home, product and collection pages, built from your catalog. Tell me what to change, or publish when it feels right."
          : "Done, it's in the preview. Tell me what to change next, or publish when it's ready.";
    const reply = [base, ...(opts?.extraLines ?? [])].join(" ");
    const actions: ChatAction[] | undefined =
      status !== "failed" && opts?.firstBuild
        ? [
            { label: "Make it bolder", onClick: () => runChatIntent({ kind: "vibe", vibe: "bold" }) },
            { label: "Warmer", onClick: () => runChatIntent({ kind: "vibe", vibe: "warm" }) },
            { label: "Looks good, publish it", kind: "primary", onClick: () => onPublishClick() },
          ]
        : undefined;
    pushMsg({ id: newId(), kind: "ai-text", text: reply, actions });
  };

  const runBuild = async (brief: string, opts?: { firstBuild?: boolean }) => {
    if (buildingRef.current) return;
    buildingRef.current = true;
    const runningPhase: BuildPhase = { kind: "running" };
    setBuildPhase(runningPhase);
    const workingId = newId();
    pushMsg({ id: workingId, kind: "ai-working", phase: runningPhase });
    try {
      const receipt = await generateStudioStore(brief.trim(), designModelRef.current);
      // Re-pull the whole studio state — generation rewrites brand settings,
      // drafts and the generation audit row — then reload the preview.
      await refresh();
      reloadPreview();
      if (!aliveRef.current) return;
      // The JSON generate path only ever returns a terminal generation status
      // (draft/no_products/failed). The multipart-only intent statuses can't
      // arrive here, but handle them honestly instead of coercing to "draft".
      if (receipt.status === "needs_intent" || receipt.status === "products_added") {
        failBuild(workingId, "That didn't produce a design. Try Build again.");
        return;
      }
      settleGeneration(workingId, receipt.status, { firstBuild: opts?.firstBuild });
    } catch (err) {
      if (!aliveRef.current) return;
      const msg = err instanceof DashboardApiError ? err.message : "Store generation failed.";
      failBuild(workingId, msg, { toast: true });
    } finally {
      buildingRef.current = false;
    }
  };

  // --- deterministic chat edits (vibe / accent / headline) --------------------
  const snapshotNow = (): { vibe: StudioVibe; accent: string; hero: StudioHero } => ({
    vibe: data?.settings.vibe ?? "minimal",
    accent: data?.settings.accent ?? "#0f766e",
    hero: data?.hero ?? DEFAULT_HERO,
  });

  const runUndo = async (snap: { vibe: StudioVibe; accent: string; hero: StudioHero }) => {
    if (chatBusyRef.current) return;
    setChatBusyBoth(true);
    try {
      // Sequential, not parallel: vibe and accent both read-modify-write the
      // same store_settings row, so running them concurrently risks a lost
      // update.
      await setStudioVibe(snap.vibe);
      await setStudioAccent(snap.accent);
      await saveStudioHero(snap.hero);
      await refresh();
      reloadPreview();
      if (!aliveRef.current) return;
      pushMsg({ id: newId(), kind: "ai-text", text: "Undone." });
    } catch (err) {
      if (!aliveRef.current) return;
      const msg = err instanceof DashboardApiError ? err.message : "Couldn't undo that.";
      toast(msg, "warn", "critical");
    } finally {
      if (aliveRef.current) setChatBusyBoth(false);
    }
  };

  const withUndo = (snap: { vibe: StudioVibe; accent: string; hero: StudioHero }): ChatAction[] => [
    { label: "Undo", onClick: () => void runUndo(snap) },
  ];

  const runDeterministic = async (
    intent: Extract<ChatIntent, { kind: "vibe" | "accent" | "hero" }>,
    opts?: { pageLabel?: string },
  ) => {
    if (chatBusyRef.current) return;
    const snap = snapshotNow();
    setChatBusyBoth(true);
    const thinkId = newId();
    pushMsg({ id: thinkId, kind: "ai-thinking" });
    try {
      let replyText: string;
      if (intent.kind === "vibe") {
        await queueMutation(() => setStudioVibe(intent.vibe));
        replyText = `Switched to a ${VIBE_LABEL[intent.vibe]} look. It's in the preview now.`;
      } else if (intent.kind === "accent") {
        await queueMutation(() => setStudioAccent(intent.color));
        replyText = "Updated the accent color. It's in the preview now.";
      } else {
        const saved = await queueMutation(() => saveStudioHero({ ...(data?.hero ?? DEFAULT_HERO), headline: intent.headline }));
        replyText = `Updated the headline to "${saved.headline}".`;
      }
      await refresh();
      reloadPreview();
      if (!aliveRef.current) return;
      const prefix = opts?.pageLabel ? `You marked up the ${opts.pageLabel} page: ` : "";
      setMessages((m) =>
        m.map((x) => (x.id === thinkId ? { id: thinkId, kind: "ai-text", text: prefix + replyText, actions: withUndo(snap) } : x)),
      );
    } catch (err) {
      if (!aliveRef.current) return;
      const msg = err instanceof DashboardApiError ? err.message : "Couldn't make that change.";
      setMessages((m) => m.map((x) => (x.id === thinkId ? { id: thinkId, kind: "ai-text", text: msg } : x)));
    } finally {
      if (aliveRef.current) setChatBusyBoth(false);
    }
  };

  const runExperiment = async (expKind: "headline" | "vibe") => {
    if (chatBusyRef.current) return;
    setChatBusyBoth(true);
    const thinkId = newId();
    pushMsg({ id: thinkId, kind: "ai-thinking" });
    try {
      const exp = await startStoreExperiment({ kind: expKind });
      if (!aliveRef.current) return;
      setData((d) => (d ? { ...d, experiment: exp } : d));
      setMessages((m) =>
        m.map((x) =>
          x.id === thinkId
            ? {
                id: thinkId,
                kind: "ai-text",
                text: `Started a test on your ${exp.name}. ${exp.why} I'll let you know how it's doing; check the pill up top.`,
              }
            : x,
        ),
      );
    } catch (err) {
      if (!aliveRef.current) return;
      const msg = err instanceof DashboardApiError ? err.message : "Couldn't start a test right now.";
      setMessages((m) => m.map((x) => (x.id === thinkId ? { id: thinkId, kind: "ai-text", text: msg } : x)));
    } finally {
      if (aliveRef.current) setChatBusyBoth(false);
    }
  };

  const runChatIntent = (intent: ChatIntent) => {
    if (isDeterministicChatIntent(intent)) {
      void runDeterministic(intent);
    } else if (intent.kind === "experiment") {
      void runExperiment(intent.expKind);
    } else {
      void runBuild(intent.brief);
    }
  };

  const onComposerSend = () => {
    if (chatBusyRef.current || buildingRef.current || attachingRef.current) return;
    const text = prompt.trim();
    const staged = attachments;
    // No attachments → today's exact text-only path, untouched.
    if (staged.length === 0) {
      if (!text) return;
      setPrompt("");
      pushMsg({ id: newId(), kind: "user-text", text });
      runChatIntent(parseChatIntent(text));
      return;
    }
    // Attachments present → they travel with the prompt via the multipart route;
    // deterministic vibe/accent/hero parsing does NOT apply. Show one image
    // bubble per file, then the text, then clear the composer + chips. The File
    // refs are captured in `files` so a needs_intent quick-reply can resubmit them.
    const files = staged.map((a) => a.file);
    for (const f of files) pushMsg({ id: newId(), kind: "user-image", imageUrl: URL.createObjectURL(f), caption: f.name });
    if (text) pushMsg({ id: newId(), kind: "user-text", text });
    setPrompt("");
    clearStagedAttachments();
    if (text) {
      // Text + images → let the model decide what the images are for.
      void runAttachmentBuild(text, files);
    } else {
      // Image-only → never spend without knowing intent; ask first.
      pushMsg({
        id: newId(),
        kind: "ai-text",
        text: "Want me to add these as products, or use them as a design reference?",
        actions: attachmentIntentActions("", files),
      });
    }
  };

  // --- markup: draw on the preview, note it, send to chat ---------------------
  const exitMarkup = () => {
    setMarkupOn(false);
    setStrokes([]);
    drawing.current = null;
    setNoteOpen(false);
    setNoteText("");
  };

  const onToggleMarkup = () => {
    if (markupOn) exitMarkup();
    else setMarkupOn(true);
  };

  const onPageChange = (p: PageKey) => {
    if (markupOn) exitMarkup(); // stroke coords are relative to the frame; a page swap invalidates them
    setPage(p);
  };
  const onDeviceChange = (d: Device) => {
    if (markupOn) exitMarkup();
    setDevice(d);
  };

  const onDrawStart = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pctPoint(e);
    drawing.current = [`${p.x.toFixed(2)} ${p.y.toFixed(2)}`];
    setStrokes((s) => [...s, `M ${p.x.toFixed(2)} ${p.y.toFixed(2)}`]);
  };
  const onDrawMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drawing.current) return;
    const p = pctPoint(e);
    drawing.current.push(`${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
    const pts = drawing.current;
    const d = `M ${pts[0]}` + pts.slice(1).map((pt) => ` L ${pt}`).join("");
    setStrokes((s) => [...s.slice(0, -1), d]);
  };
  const onDrawEnd = () => {
    if (drawing.current && strokes.length > 0) setNoteOpen(true);
    drawing.current = null;
  };

  const submitMarkupNote = () => {
    const note = noteText.trim();
    if (!note) return;
    const pageLabel = PAGE_LABEL[page] ?? "store";
    const intent = parseChatIntent(note);
    pushMsg({ id: newId(), kind: "user-text", text: `[Marked up the ${pageLabel} page] ${note}` });
    exitMarkup();
    if (isDeterministicChatIntent(intent)) {
      void runDeterministic(intent, { pageLabel });
    } else {
      // A markup scribble is a narrower channel than the composer: an
      // unmatched note reads as "noted", never a full rebuild or a test.
      pushMsg({
        id: newId(),
        kind: "ai-text",
        text: `Noted on the ${pageLabel} page: "${note}". I'll keep it in mind; nothing's changed yet.`,
      });
    }
  };

  // --- composer attachments: stage, then route on send ------------------------
  // Screen picks against the mirrored server caps (pure planStagedAttachments),
  // report every rejection in chat (rule 12), and stage the survivors as chips.
  const onAttachFiles = (allFiles: File[]) => {
    const plan = planStagedAttachments(allFiles, attachments.length);
    if (plan.skipped.length > 0) {
      pushMsg({
        id: newId(),
        kind: "ai-text",
        text: `Skipped ${plan.skipped.map((f) => `"${f.name}"`).join(", ")} — I can only use PNG, JPEG, WebP or GIF images right now.`,
      });
    }
    if (plan.oversize.length > 0) {
      pushMsg({
        id: newId(),
        kind: "ai-text",
        // "under 3.75 MB" is the merchant-facing phrasing of MAX_ATTACHMENT_BYTES, matching the server's message.
        text: `${plan.oversize.map((f) => `"${f.name}"`).join(", ")} ${plan.oversize.length === 1 ? "is" : "are"} too large — attach images under 3.75 MB.`,
      });
    }
    if (plan.overflow > 0) {
      pushMsg({
        id: newId(),
        kind: "ai-text",
        text:
          plan.accepted.length > 0
            ? `You can attach up to 4 images at a time, so I kept the first ${plan.accepted.length}.`
            : "You already have 4 images attached. Remove one to add another.",
      });
    }
    if (plan.accepted.length === 0) return;
    const staged = plan.accepted.map((file) => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) }));
    setAttachments((prev) => [...prev, ...staged]);
  };

  const onRemoveAttachment = (id: string) => {
    setAttachments((prev) => {
      const found = prev.find((a) => a.id === id);
      if (found) URL.revokeObjectURL(found.url);
      return prev.filter((a) => a.id !== id);
    });
  };

  // Revoke the staged chips' thumbnail URLs and clear them. The user-image
  // bubbles get their OWN long-lived URLs at send time, so this never touches
  // anything the thread is still showing.
  const clearStagedAttachments = () => {
    setAttachments((prev) => {
      for (const a of prev) URL.revokeObjectURL(a.url);
      return [];
    });
  };

  // One honest chat line per server-created product entry (StudioAddedProduct):
  // created / image-attach failed / create failed.
  const productLine = (p: StudioAddedProduct): string => {
    if (p.error) return `Couldn't add "${p.title}": ${p.error}.`;
    if (p.imageError) return `Added draft "${p.title}", but its image failed to upload. Add one in Products.`;
    return `Added "${p.title}" as a draft product.`;
  };

  const toastProductFailures = (failedCount: number, total: number) => {
    const shortSummary =
      failedCount === total
        ? "Couldn't add those images. See chat for details."
        : `${failedCount} of ${total} images had a problem. See chat for details.`;
    toast(shortSummary, "warn", "critical");
  };

  // Add held images as draft products, client-side (the "Add as products" reply).
  // Extracted from the old auto-convert path so its per-item messaging, partial-
  // failure toast and refresh live in one place — never silently drops an item.
  const runAddProductsFromImages = async (files: File[]) => {
    if (attachingRef.current) {
      toast("Still adding the previous images. Try again in a moment.");
      return;
    }
    if (chatBusyRef.current || buildingRef.current) return;
    setAttachingBoth(true);
    // Everything after the guard sits in one try/finally so EVERY exit (the
    // unmount early-return included) releases the ref — a stuck true would
    // permanently dead-end the quick-reply.
    try {
      const results = await Promise.allSettled(files.map((file) => addProductFromImage(file)));
      if (!aliveRef.current) return;
      const lines = results.map((r, i) => {
        if (r.status === "fulfilled" && !r.value.imageError) return `Added "${r.value.title}" as a draft product.`;
        if (r.status === "fulfilled") {
          return `Added draft "${r.value.title}", but its image failed to upload. Add one in Products.`;
        }
        const msg = r.reason instanceof DashboardApiError ? r.reason.message : "upload failed";
        return `Couldn't add "${files[i].name}": ${msg}.`;
      });
      pushMsg({ id: newId(), kind: "ai-text", text: lines.join(" ") });
      const failedCount = results.filter((r) => r.status === "rejected" || (r.status === "fulfilled" && r.value.imageError)).length;
      if (failedCount > 0) toastProductFailures(failedCount, results.length);
      await refresh();
      reloadPreview();
    } finally {
      attachingRef.current = false;
      if (aliveRef.current) setAttaching(false);
    }
  };

  // The two quick-reply buttons shown when intent is unresolved (an image-only
  // send, or a needs_intent receipt). Reference resubmits WITH the original brief
  // and an explicit intent, so the server skips re-classification (no loop).
  const attachmentIntentActions = (brief: string, files: File[]): ChatAction[] => [
    { label: "Add as products", kind: "primary", onClick: () => void runAddProductsFromImages(files) },
    { label: "Use as design reference", onClick: () => void runAttachmentBuild(brief, files, "reference") },
  ];

  // Multipart generate: images travel WITH the brief. Reuses runBuild's lifecycle
  // (working card + veil + settleGeneration), but the receipt can also be
  // needs_intent (ask), products_added (drafts only), or products-then-generation-
  // failure — each handled honestly rather than faked as a finished build.
  const runAttachmentBuild = async (
    brief: string,
    files: File[],
    intent?: "products" | "reference" | "both",
  ) => {
    if (buildingRef.current || chatBusyRef.current || attachingRef.current) return;
    buildingRef.current = true;
    const runningPhase: BuildPhase = { kind: "running" };
    setBuildPhase(runningPhase);
    const workingId = newId();
    pushMsg({ id: workingId, kind: "ai-working", phase: runningPhase });
    // Once the server has answered, drafts may already be written — a retry from
    // that point would re-classify and mint duplicates, so "Try again" is only
    // offered while the failure is provably pre-receipt.
    let gotReceipt = false;
    try {
      const receipt: StudioGenerateReceipt = await generateStudioStoreWithImages(
        brief.trim(),
        files,
        designModelRef.current,
        intent,
      );
      gotReceipt = true;
      await refresh();
      reloadPreview();
      if (!aliveRef.current) return;

      // Nothing ran — the model couldn't tell what the images were for. Drop the
      // working card and ask, holding the same files for the quick-reply resubmit.
      if (receipt.status === "needs_intent") {
        clearBuildCard(workingId);
        pushMsg({
          id: newId(),
          kind: "ai-text",
          text: "I couldn't tell what to do with those images. Add them as products, or use them as a design reference?",
          actions: attachmentIntentActions(brief, files),
        });
        return;
      }

      const products = receipt.products ?? [];
      const productLines = products.map(productLine);
      const failedCount = products.filter((p) => p.error || p.imageError).length;

      // Drafts added, no generation ran.
      if (receipt.status === "products_added") {
        clearBuildCard(workingId);
        if (productLines.length > 0) pushMsg({ id: newId(), kind: "ai-text", text: productLines.join(" ") });
        if (failedCount > 0) toastProductFailures(failedCount, products.length);
        return;
      }

      // Products were written, THEN generation threw (no runId): report both facts.
      if (receipt.status === "failed" && !receipt.runId) {
        failBuild(
          workingId,
          productLines.length > 0
            ? `${productLines.join(" ")} But the design generation failed — try Build again.`
            : "The design generation failed — try Build again.",
          { toast: true },
        );
        return;
      }

      // A generation ran (draft / no_products / soft-degraded failed-with-runId).
      const extraLines = [...productLines];
      if (receipt.referencesUnread) {
        extraLines.push("I couldn't read the attached reference images, so the design was generated without them.");
      }
      settleGeneration(workingId, receipt.status, { extraLines });
      if (failedCount > 0) toastProductFailures(failedCount, products.length);
    } catch (err) {
      if (!aliveRef.current) return;
      const msg = err instanceof DashboardApiError ? err.message : "Store generation failed.";
      // The chips were cleared at send, so a transient failure (429/network/502)
      // must re-offer the held files — otherwise the merchant re-picks everything.
      failBuild(workingId, msg, {
        toast: true,
        ...(gotReceipt
          ? {}
          : { actions: [{ label: "Try again", kind: "primary", onClick: () => void runAttachmentBuild(brief, files, intent) }] }),
      });
    } finally {
      buildingRef.current = false;
    }
  };

  // --- welcome overlay actions --------------------------------------------------
  const onWelcomeBuildPlain = () => void runBuild("", { firstBuild: true });

  const onWelcomeBuildWithVibe = async (vibe: StudioVibe) => {
    try {
      await setStudioVibe(vibe);
    } catch (err) {
      // A failed vibe pre-set isn't fatal — the build still runs, just against
      // whatever vibe is currently stored. Say so and keep going.
      const msg = err instanceof DashboardApiError ? err.message : "Couldn't set that look. Building anyway.";
      toast(msg, "warn", "critical");
    }
    void runBuild("", { firstBuild: true });
  };

  const onWelcomeAddProduct = async (line: string) => {
    const parsed = parseProductLine(line);
    // A priced product goes live in the catalog so the first build can design
    // around it (the whole point of this branch); without a price it stays a
    // draft, since the storefront can't sell it yet. Active physical products
    // must ship-complete (validate.ts), so the one-liner gets standard small-
    // parcel defaults the merchant can correct in Products.
    const active = parsed.priceCents != null;
    try {
      await saveProduct({
        title: parsed.title,
        status: active ? "active" : "draft",
        variants: [
          active
            ? { retailPriceCents: parsed.priceCents ?? undefined, weightGrams: 500, lengthMm: 200, widthMm: 150, heightMm: 100 }
            : { retailPriceCents: parsed.priceCents ?? undefined },
        ],
      });
      toast(
        active
          ? `"${parsed.title}" added with standard parcel shipping defaults; adjust in Products.`
          : `Draft product "${parsed.title}" created.`,
      );
      await refresh();
      void runBuild("", { firstBuild: true });
    } catch (err) {
      const msg = err instanceof DashboardApiError ? err.message : "Couldn't create that product.";
      toast(msg, "warn", "critical");
    }
  };

  // --- publish ------------------------------------------------------------------
  const openStorefront = () => {
    if (data) window.open(data.storefrontUrl, "_blank", "noopener");
  };

  const runPublish = async () => {
    if (!data || publishingRef.current) return;
    const firstPublish = !data.hasPublished;
    setConfirmingPublish(false);
    setPublishingBoth(true);
    try {
      // Flush any in-flight deterministic edit first, so the published
      // snapshot matches the last requested vibe/accent/hero change.
      await mutationChain.current;
      await publishStudioStore();
      if (!aliveRef.current) return;
      setData((d) => (d ? { ...d, hasPublished: true } : d));
      reloadPreview();
      if (firstPublish) {
        confettiFrom(badgeRef.current);
        const actions: ChatAction[] = [{ label: "Open my store", kind: "primary", onClick: openStorefront }];
        if (!data.checkoutReady) {
          actions.push({ label: "Connect payouts", onClick: () => app.navigate("payments") });
        }
        pushMsg({ id: newId(), kind: "ai-text", text: `Your store is live at ${data.storefrontUrl}.`, actions });
      } else {
        toast("Published to your storefront");
      }
    } catch (err) {
      if (!aliveRef.current) return;
      const msg = err instanceof DashboardApiError ? err.message : "Could not publish.";
      toast(msg, "warn", "critical");
    } finally {
      if (aliveRef.current) setPublishingBoth(false);
    }
  };

  const publishPieces: MissingPiece[] = data ? missingPieces(data) : [];
  const onPublishClick = () => {
    if (!data || publishingRef.current) return;
    if (publishPieces.length > 0) {
      setConfirmingPublish(true);
      return;
    }
    void runPublish();
  };

  const onDecideExperiment = async (decision: "ship" | "keep" | "stop") => {
    if (!data?.experiment || decidingExperiment) return;
    setDecidingExperiment(true);
    try {
      const exp = await decideStoreExperiment(data.experiment.id, decision);
      if (!aliveRef.current) return;
      setData((d) => (d ? { ...d, experiment: exp } : d));
      reloadPreview();
      const text =
        decision === "ship"
          ? `Shipped: the winning ${exp.name} is live for everyone.`
          : decision === "keep"
            ? "Kept the original. The idea stays in my back pocket."
            : "Stopped the test early.";
      pushMsg({ id: newId(), kind: "ai-text", text });
    } catch (err) {
      if (!aliveRef.current) return;
      const msg = err instanceof DashboardApiError ? err.message : "Couldn't update the test.";
      toast(msg, "warn", "critical");
    } finally {
      if (aliveRef.current) setDecidingExperiment(false);
    }
  };

  // --- render ----------------------------------------------------------------
  if (!data) {
    return (
      <div className="cd-screen cd-screen-storefront" data-screen-label="Store">
        <div style={{ padding: "14px 28px 0" }}>
          <StoreSubTabs app={app} />
        </div>
        <div className="cd-studio">
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Placeholder
              icon="store"
              title={loading ? "Loading your store" : "Store unavailable"}
              sub={
                loading
                  ? "Reading your storefront draft and brand kit."
                  : "Could not load the studio just now. Refresh to try again."
              }
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
  const previewSrc = `${PREVIEW_PATH}?page=${page}&v=${previewVersion}`;
  // Before the first build → invite a prompt; after one build the full studio takes over.
  const promptCanvas = showPromptCanvas(data);

  return (
    <div className="cd-screen cd-screen-storefront" data-screen-label="Store">
      <div style={{ padding: "14px 28px 0" }}>
        <StoreSubTabs app={app} />
      </div>
      <div className="cd-studio">
        <ChatRail
          messages={messages}
          prompt={prompt}
          onPromptChange={setPrompt}
          onSend={onComposerSend}
          busy={chatBusy || building}
          attaching={attaching}
          onAttachFiles={onAttachFiles}
          attachments={attachments.map((a) => ({ id: a.id, url: a.url, name: a.file.name }))}
          onRemoveAttachment={onRemoveAttachment}
          model={designModel}
          onModelChange={setDesignModelBoth}
        />

        <div className="cd-stage">
          {promptCanvas ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Placeholder
                icon="sparkle"
                title="Prompt anything"
                sub="Tell Calderyn what to build and it appears here."
              />
            </div>
          ) : (
            <>
          <TopBar
            ref={badgeRef}
            storefrontUrl={data.storefrontUrl}
            onOpenStorefront={openStorefront}
            hasPublished={data.hasPublished}
            building={building}
            experiment={data.experiment}
            onDecideExperiment={(d) => void onDecideExperiment(d)}
            decidingExperiment={decidingExperiment}
            page={page}
            onPageChange={onPageChange}
            device={device}
            onDeviceChange={onDeviceChange}
            markupOn={markupOn}
            onToggleMarkup={onToggleMarkup}
            onPublish={onPublishClick}
            publishing={publishing}
          />

          <div className="cd-stage-page">
            <div className="cd-canvas-frame-wrap" data-device={device}>
              <iframe
                key="store-preview"
                className="cd-canvas-frame"
                title="Store preview"
                src={previewSrc}
                sandbox="allow-same-origin allow-scripts"
              />
              <div className="cd-canvas-veil" data-on={building ? "1" : "0"} aria-hidden="true">
                {/* Branded storefront skeleton: paints instantly on Build so a generation reads as
                    the store forming, not a dimmed stale page. Tinted with the shop's primary. */}
                <div className="cd-canvas-skel" style={{ ["--cd-skel" as string]: data.settings.accent }}>
                  <div className="cd-canvas-skel__hero" />
                  <div className="cd-canvas-skel__row" />
                  <div className="cd-canvas-skel__row cd-canvas-skel__row--short" />
                  <div className="cd-canvas-skel__grid"><span /><span /><span /></div>
                </div>
              </div>
              <svg className="cd-mark-layer" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                {strokes.map((d, i) => (
                  <path
                    key={i}
                    d={d}
                    fill="none"
                    stroke="var(--red)"
                    strokeWidth={1.6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </svg>
              {markupOn && (
                <button
                  type="button"
                  className="cd-mark-capture"
                  aria-label="Draw on the page"
                  onPointerDown={onDrawStart}
                  onPointerMove={onDrawMove}
                  onPointerUp={onDrawEnd}
                  onPointerCancel={onDrawEnd}
                />
              )}
              {noteOpen && (
                <div className="cd-mark-note">
                  <input
                    autoFocus
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
                      if (e.key === "Enter" && noteText.trim()) submitMarkupNote();
                    }}
                    placeholder="What should change here?"
                    aria-label="Markup note"
                  />
                  <Btn kind="primary" small onClick={submitMarkupNote}>
                    Send
                  </Btn>
                </div>
              )}

              {confirmingPublish && publishPieces.length > 0 && (
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
                    <Btn kind="primary" small onClick={() => void runPublish()} disabled={publishing || building}>
                      Publish anyway
                    </Btn>
                    <Btn small onClick={() => setConfirmingPublish(false)}>
                      Keep editing
                    </Btn>
                  </div>
                </div>
              )}
            </div>
          </div>
            </>
          )}
        </div>

        {welcomeVisible && (
          <WelcomeOverlay
            authBase={app.authBase}
            branch={branch}
            importRun={importRun}
            buildPhase={buildPhase}
            productCount={data.productCount}
            onBuildPlain={onWelcomeBuildPlain}
            onBuildWithVibe={(vibe) => void onWelcomeBuildWithVibe(vibe)}
            onAddProduct={(line) => void onWelcomeAddProduct(line)}
          />
        )}
      </div>
    </div>
  );
}
