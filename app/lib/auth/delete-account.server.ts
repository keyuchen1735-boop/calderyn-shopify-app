// app/lib/auth/delete-account.server.ts
//
// Permanent, self-service account deletion for first-party (email / Google)
// merchants — frees the account's email for re-registration and tears down the
// tenant. Relies on Postgres ON DELETE CASCADE: deleting the users row cascades
// its membership / dashboard_sessions / password_reset_token; deleting the
// shops row cascades every shop-scoped table (products, orders, campaigns, …).

import { getSupabase } from "../supabase.server";

export interface DeleteAccountResult {
  /** True when the shop and all its data were torn down (this user was its sole
   *  member). False when other members remain, so only this user was removed. */
  shopDeleted: boolean;
}

/**
 * Permanently delete a first-party account and, when the user is the shop's sole
 * member, the shop and all of its data.
 *
 * Ordered user-first, then shop, on purpose: deleting the users row frees the
 * email immediately, so even if the subsequent shop teardown fails the merchant
 * can still re-register with the same address. The worst case of a mid-way
 * failure is an unreachable, membership-less orphan shop — never a permanently
 * taken email.
 *
 * A co-owned shop (not a v1 shape, but guarded) keeps its data and just loses
 * this member.
 */
export async function deleteAccount(
  userId: string,
  shopId: string,
): Promise<DeleteAccountResult> {
  const sb = getSupabase();

  // Is this user the shop's only member? Only then may we destroy the store, so
  // one owner deleting their account can never wipe a co-owner's data. Require at
  // least one row (this user's own membership): an empty/anomalous read fails
  // safe — delete the user but leave the shop rather than tear down a tenant we
  // couldn't confirm the caller solely owns.
  const { data: members, error: membersError } = await sb
    .from("membership")
    .select("user_id")
    .eq("shop_id", shopId);
  if (membersError) throw membersError;
  const memberRows = members ?? [];
  const soleMember =
    memberRows.length > 0 && memberRows.every((m) => String(m.user_id) === userId);

  // 1. Delete the user first — frees the email, cascades membership /
  //    dashboard_sessions / password_reset_token.
  const { error: userError } = await sb.from("users").delete().eq("id", userId);
  if (userError) throw userError;

  // 2. Tear down the tenant when this user owned it alone — cascades every
  //    shop-scoped table.
  if (soleMember) {
    const { error: shopError } = await sb.from("shops").delete().eq("id", shopId);
    if (shopError) throw shopError;
  }

  return { shopDeleted: soleMember };
}
