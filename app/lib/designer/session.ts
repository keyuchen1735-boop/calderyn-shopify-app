// Client-side designer session singleton: the running turn, its message
// thread, and busy state live at module level so a build keeps streaming
// while the merchant explores other screens. DesignerStudio subscribes on
// mount and re-attaches to whatever is in flight; the sidebar subscribes to
// show a working indicator on the Store item.
import type { ChatMsg } from "~/components/dashboard/store/chat-types";
import type { StudioDesignModel } from "~/lib/storebuilder/studio-types";
import { DashboardApiError } from "~/lib/dashboard/client";
import { sendDesignerMessage } from "./client";

export interface DesignerSessionState {
  messages: ChatMsg[];
  busy: boolean;
  /** Wall-clock start of the running turn, for elapsed labels that survive
   *  screen switches. */
  busySince: number | null;
  /** Bumped whenever documents changed so a remounted preview shows them. */
  previewVersion: number;
}

let state: DesignerSessionState = { messages: [], busy: false, busySince: null, previewVersion: 0 };
const listeners = new Set<() => void>();
let seq = 0;
let seeded = false;

function emit(): void {
  for (const listener of listeners) listener();
}
function patch(next: Partial<DesignerSessionState>): void {
  state = { ...state, ...next };
  emit();
}

export function subscribeDesignerSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function getDesignerSession(): DesignerSessionState {
  return state;
}
export function designerNewId(): number {
  seq += 1;
  return seq;
}
export function pushDesignerMsg(msg: ChatMsg): void {
  patch({ messages: [...state.messages, msg] });
}
/** Reload recovery: seed the thread from the saved chat exactly once, and
 *  never over a thread that already has live messages. */
export function seedDesignerMessages(rows: Array<{ role: "user" | "assistant"; body: string }>): void {
  if (seeded || state.messages.length > 0) {
    seeded = true;
    return;
  }
  seeded = true;
  patch({
    messages: rows.map((row) => ({
      id: designerNewId(),
      kind: row.role === "user" ? ("user-text" as const) : ("ai-text" as const),
      text: row.body,
    })),
  });
}

/** One conversational turn, owned by the session so it outlives the screen.
 *  Returns immediately; subscribers watch it land. */
export function runDesignerTurn(input: {
  message: string;
  page: string;
  model: StudioDesignModel;
  mode?: "template" | "scratch";
  firstBuild: boolean;
  /** Fired when a first build (or resume) settles, so the studio can refresh
   *  its ready/unbuilt state if it's still mounted. */
  onSettled?: () => void;
}): void {
  if (state.busy) return;
  patch({ busy: true, busySince: Date.now() });
  const thinkId = designerNewId();
  pushDesignerMsg({ id: thinkId, kind: "ai-thinking" });
  void (async () => {
    try {
      const turn = await sendDesignerMessage({
        message: input.message,
        page: input.page,
        model: input.model,
        ...(input.firstBuild ? { mode: input.mode ?? "template" } : {}),
        onPage: (event) => {
          patch({
            messages: [
              ...state.messages.filter((m) => m.id !== thinkId),
              { id: designerNewId(), kind: "ai-text", text: `${event.reply} (${event.index}/${event.total} pages ready — it's in the preview.)` },
              { id: thinkId, kind: "ai-thinking" },
            ],
            previewVersion: state.previewVersion + 1,
          });
        },
      });
      patch({
        messages: state.messages
          .filter((m) => m.id !== thinkId)
          .concat({ id: designerNewId(), kind: "ai-text", text: turn.reply }),
        previewVersion: turn.changed ? state.previewVersion + 1 : state.previewVersion,
      });
    } catch (err) {
      const msg = err instanceof DashboardApiError ? err.message : "Couldn't make that change. Try again.";
      patch({
        messages: state.messages.filter((m) => m.id !== thinkId).concat({ id: designerNewId(), kind: "ai-text", text: msg }),
      });
    } finally {
      patch({ busy: false, busySince: null });
      input.onSettled?.();
    }
  })();
}
