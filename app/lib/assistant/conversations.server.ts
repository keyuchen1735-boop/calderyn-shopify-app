import { getSupabase, resolveShopId } from "../supabase.server";
import type { ChatMessage, ConversationSummary, DraftedAction } from "./types";
import type { ActionReceipt, PendingActionCard } from "./actions/registry-types";

interface AppendInput {
  role: "user" | "assistant";
  content: string;
  draftedAction?: DraftedAction | null;
  receipts?: ActionReceipt[] | null;
  pendingAction?: PendingActionCard | null;
}

const MESSAGE_COLS = "id, role, content, drafted_action, receipts, pending_action, created_at";

function notFound(conversationId: string): Error {
  const e = new Error(`Conversation ${conversationId} not found`) as Error & {
    code: string;
    status: number;
  };
  e.code = "CONVERSATION_NOT_FOUND";
  e.status = 404;
  return e;
}

function rowToMessage(r: Record<string, unknown>): ChatMessage {
  return {
    id: String(r.id),
    role: r.role as ChatMessage["role"],
    content: String(r.content ?? ""),
    draftedAction: (r.drafted_action as DraftedAction | null) ?? null,
    receipts: (r.receipts as ActionReceipt[] | null) ?? [],
    pendingAction: (r.pending_action as PendingActionCard | null) ?? null,
    createdAt: String(r.created_at),
  };
}

async function assertOwned(shopId: string, conversationId: string): Promise<void> {
  const { data, error } = await getSupabase()
    .from("assistant_conversations")
    .select("id")
    .eq("shop_id", shopId)
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFound(conversationId);
}

export async function listConversations(shopDomain: string): Promise<ConversationSummary[]> {
  const shopId = await resolveShopId(shopDomain);
  const { data, error } = await getSupabase()
    .from("assistant_conversations")
    .select("id, title, updated_at")
    .eq("shop_id", shopId)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    title: (r.title as string | null) ?? null,
    updatedAt: String(r.updated_at),
  }));
}

export async function getMessages(
  shopDomain: string,
  conversationId: string,
): Promise<ChatMessage[]> {
  const shopId = await resolveShopId(shopDomain);
  await assertOwned(shopId, conversationId);
  const { data, error } = await getSupabase()
    .from("assistant_messages")
    .select(MESSAGE_COLS)
    .eq("shop_id", shopId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map(rowToMessage);
}

export async function createConversation(
  shopDomain: string,
  title: string | null,
): Promise<string> {
  const shopId = await resolveShopId(shopDomain);
  const { data, error } = await getSupabase()
    .from("assistant_conversations")
    .insert({ shop_id: shopId, title })
    .select("id")
    .single();
  if (error) throw error;
  return String(data.id);
}

export async function appendMessage(
  shopDomain: string,
  conversationId: string,
  input: AppendInput,
): Promise<ChatMessage> {
  const shopId = await resolveShopId(shopDomain);
  await assertOwned(shopId, conversationId);
  const sb = getSupabase();
  const { data, error } = await sb
    .from("assistant_messages")
    .insert({
      shop_id: shopId,
      conversation_id: conversationId,
      role: input.role,
      content: input.content,
      drafted_action: input.draftedAction ?? null,
      receipts: input.receipts ?? null,
      pending_action: input.pendingAction ?? null,
    })
    .select(MESSAGE_COLS)
    .single();
  if (error) throw error;
  const { error: upErr } = await sb
    .from("assistant_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("id", conversationId);
  if (upErr) throw upErr;
  return rowToMessage(data);
}
