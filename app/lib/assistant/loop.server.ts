import type Anthropic from "@anthropic-ai/sdk";
import type { DraftedAction } from "./types";
import type { ToolDispatchResult } from "./tools.server";

export type CreateMessageFn = (
  params: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Message>;

export interface RunTurnParams {
  createMessage: CreateMessageFn;
  model: string;
  system: Anthropic.TextBlockParam[];
  tools: Anthropic.Tool[];
  dispatchTool: (name: string, input: Record<string, unknown>) => Promise<ToolDispatchResult>;
  history: Anthropic.MessageParam[];
  userMessage: string;
  maxToolTurns?: number;
  maxTokens?: number;
}

export interface RunTurnResult {
  text: string;
  draftedAction: DraftedAction | null;
  stoppedAtCap: boolean;
}

const DEFAULT_MAX_TOOL_TURNS = 8;
const DEFAULT_MAX_TOKENS = 1536;

export async function runAssistantTurn(p: RunTurnParams): Promise<RunTurnResult> {
  const maxToolTurns = p.maxToolTurns ?? DEFAULT_MAX_TOOL_TURNS;
  const maxTokens = p.maxTokens ?? DEFAULT_MAX_TOKENS;
  const messages: Anthropic.MessageParam[] = [
    ...p.history,
    { role: "user", content: p.userMessage },
  ];
  let draftedAction: DraftedAction | null = null;

  for (let turn = 0; turn <= maxToolTurns; turn++) {
    const res = await p.createMessage({
      model: p.model,
      max_tokens: maxTokens,
      system: p.system,
      tools: p.tools,
      messages,
    });

    const toolUses = res.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // Hitting the token cap truncates the response — any tool_use block is
    // incomplete and unsafe to dispatch, and the text (if any) is partial. Don't
    // treat it as a finished turn: surface what we have, or a clear message, so
    // the user never gets a silent blank reply.
    if (res.stop_reason === "max_tokens") {
      const partial = extractText(res);
      return {
        text:
          partial ||
          "I ran out of room before I could finish that. Try narrowing the question or asking for one thing at a time.",
        draftedAction,
        stoppedAtCap: true,
      };
    }

    if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
      return { text: extractText(res), draftedAction, stoppedAtCap: false };
    }

    if (turn === maxToolTurns) {
      const partial = extractText(res);
      return {
        text:
          partial ||
          "I gathered a lot of data but ran out of steps before finishing. Please ask a more specific follow-up.",
        draftedAction,
        stoppedAtCap: true,
      };
    }

    messages.push({ role: "assistant", content: res.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const out = await p.dispatchTool(tu.name, (tu.input ?? {}) as Record<string, unknown>);
      if (out.draftedAction) draftedAction = out.draftedAction;
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: out.content,
        is_error: out.isError,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  // Unreachable (the cap branch returns), but keeps the type checker happy.
  return { text: "", draftedAction, stoppedAtCap: true };
}

function extractText(res: Anthropic.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
