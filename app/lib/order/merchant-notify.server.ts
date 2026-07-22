// Merchant "you have a new order" email. Server-only. The buyer-facing
// confirmation (confirmation-email.server.ts) told the buyer; until now NOTHING
// told the merchant — a paid order sat silently in the Orders tab until they
// happened to look. Wired from the same payment_intent.succeeded webhook, gated
// on FIRST delivery, so the merchant hears about each order at-most-once and
// only after the money is genuinely captured.
//
// The email is also the "what do I do now" guide for a first-time seller: it
// lists the items, links straight to the order, and spells out the fulfil steps
// (pack → buy label or add tracking → buyer gets the shipping email
// automatically → funds land in the Stripe balance).
//
// PII hygiene: buyer + merchant emails are read server-side only to address
// the message and are never logged. Never throws — a delivery failure must not
// break webhook processing.

import { getSupabase } from "~/lib/supabase.server";
import { sendEmail } from "~/lib/email/send.server";
import { formatOrderRef } from "./checkout.server";

export interface MerchantNotifyResult {
  sent: boolean;
  id?: string;
  error?: string;
}

/** Display-only formatting; money stays integer cents everywhere else. */
function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

const DASHBOARD_ORIGIN = "https://app.calderyncompany.com";

/**
 * Best-effort merchant contact email for a shop. First-party shops: the
 * earliest owner membership's user email. Shopify-connected shops without a
 * first-party owner: the account-owner session email (same preference ladder
 * autopilot's notifier uses). Null when neither exists — caller skips.
 */
export async function merchantEmailForShop(shopId: string): Promise<string | null> {
  const sb = getSupabase();
  try {
    const membership = await sb
      .from("membership")
      .select("role, created_at, user:users(email)")
      .eq("shop_id", shopId)
      .order("created_at", { ascending: true });
    if (!membership.error) {
      const rows = (membership.data ?? []) as Array<{
        role: string | null;
        user: { email?: string | null } | null;
      }>;
      const best = rows.find((r) => r.role === "owner" && r.user?.email) ?? rows.find((r) => r.user?.email);
      if (best?.user?.email) return best.user.email;
    }

    const shopRow = await sb.from("shops").select("shop_domain").eq("id", shopId).maybeSingle();
    const shopDomain = (shopRow.data as { shop_domain?: string | null } | null)?.shop_domain ?? null;
    if (!shopDomain) return null;
    const sessions = await sb
      .from("shopify_sessions")
      .select("email, isOnline, accountOwner")
      .eq("shop", shopDomain)
      .not("email", "is", null);
    const rows = (sessions.data ?? []) as Array<{
      email: string | null;
      isOnline: boolean;
      accountOwner: boolean;
    }>;
    const best =
      rows.find((r) => r.isOnline && r.accountOwner) ??
      rows.find((r) => r.isOnline) ??
      rows.find((r) => r.accountOwner) ??
      rows[0] ??
      null;
    return best?.email ?? null;
  } catch {
    return null; // best-effort: no contact means no notification, never an error
  }
}

/**
 * Email the merchant that a new order was paid. Skips the go-live test probe
 * (channel = 'test' — its 50¢ auto-refunded charge is not a real order).
 * Returns a structured result; NEVER throws.
 */
export async function sendMerchantNewOrderNotice(
  shopId: string,
  orderId: string,
): Promise<MerchantNotifyResult> {
  try {
    if (!shopId || !orderId) return { sent: false, error: "shopId and orderId are required" };

    const sb = getSupabase();
    const orderRes = await sb
      .from("orders")
      .select("id, total_cents, currency, channel")
      .eq("shop_id", shopId)
      .eq("id", orderId)
      .maybeSingle();
    if (orderRes.error) throw orderRes.error;
    if (!orderRes.data) return { sent: false, error: "order not found" };
    const order = orderRes.data as { total_cents: number; currency: string; channel: string | null };
    if (order.channel === "test") return { sent: false, error: "test-channel order" };

    const to = await merchantEmailForShop(shopId);
    if (!to) {
      console.warn(`[merchant-notify] no merchant email for shop ${shopId}; order ${orderId} notice skipped`);
      return { sent: false, error: "no merchant email" };
    }

    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.ORDER_CONFIRM_FROM || process.env.PILOT_FROM || process.env.DIGEST_FROM;
    if (!apiKey || !from) {
      console.warn(
        `[merchant-notify] cannot notify for order ${orderId} (shop ${shopId}): missing ${!apiKey ? "RESEND_API_KEY" : "ORDER_CONFIRM_FROM/PILOT_FROM/DIGEST_FROM"}`,
      );
      return { sent: false, error: "email transport not configured" };
    }

    const linesRes = await sb
      .from("order_line")
      .select("title_snapshot, quantity, unit_price_cents")
      .eq("shop_id", shopId)
      .eq("order_id", orderId)
      // Same deterministic ordering the buyer receipt uses (order_line has no created_at).
      .order("title_snapshot", { ascending: true });
    const lines = (linesRes.error ? [] : (linesRes.data ?? [])) as Array<{
      title_snapshot: string | null;
      quantity: number;
      unit_price_cents: number;
    }>;

    const ref = formatOrderRef(orderId);
    const total = money(Number(order.total_cents), String(order.currency));
    const orderUrl = `${DASHBOARD_ORIGIN}/dashboard/orders/${encodeURIComponent(orderId)}`;
    const lineText = lines.map(
      (l) => `  ${l.quantity} × ${l.title_snapshot ?? "Item"} — ${money(l.unit_price_cents * l.quantity, order.currency)}`,
    );

    const subject = `New order ${ref} — ${total}`;
    const text = [
      `You have a new order.`,
      ``,
      `Order ${ref} — ${total}`,
      ...(lineText.length ? ["", ...lineText] : []),
      ``,
      `Open the order: ${orderUrl}`,
      ``,
      `What happens next:`,
      `1. Pack the items.`,
      `2. Open the order and choose Fulfill — buy a shipping label there, or enter your own tracking number.`,
      `3. Your customer automatically gets a shipping email with tracking once you fulfill.`,
      ``,
      `The payment is already captured; it lands in your Stripe balance and pays out on your normal payout schedule (Settings → Payouts).`,
    ].join("\n");

    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const lineHtml = lines
      .map(
        (l) =>
          `<tr><td style="padding:4px 0;color:#1D1D1F;font-size:14px;">${l.quantity} × ${esc(l.title_snapshot ?? "Item")}</td>` +
          `<td style="padding:4px 0;color:#1D1D1F;font-size:14px;text-align:right;">${esc(money(l.unit_price_cents * l.quantity, order.currency))}</td></tr>`,
      )
      .join("");
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#F4F5F7;padding:32px 16px;margin:0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;">
    <tr><td>
      <p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#6B7280;">New order</p>
      <h1 style="margin:0 0 6px;font-size:20px;font-weight:700;color:#1D1D1F;letter-spacing:-0.02em;">Order ${esc(ref)}</h1>
      <p style="margin:0 0 20px;font-size:15px;color:#4B5563;">Paid in full — <strong style="color:#1D1D1F;">${esc(total)}</strong></p>
      ${lineHtml ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F9FAFB;border-radius:8px;padding:12px 16px;margin:0 0 20px;"><tr><td style="padding:12px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${lineHtml}</table></td></tr></table>` : ""}
      <a href="${orderUrl}" style="display:inline-block;background:#24556E;color:#fff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:8px;margin:0 0 24px;">
        Open the order
      </a>
      <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#1D1D1F;">What happens next</p>
      <ol style="margin:0 0 20px;padding-left:18px;font-size:14px;color:#4B5563;line-height:1.6;">
        <li>Pack the items.</li>
        <li>Open the order and choose <strong>Fulfill</strong> — buy a shipping label there, or enter your own tracking number.</li>
        <li>Your customer automatically gets a shipping email with tracking once you fulfill.</li>
      </ol>
      <p style="margin:0;font-size:12px;color:#9CA3AF;line-height:1.5;">The payment is already captured; it lands in your Stripe balance and pays out on your normal schedule (Settings &rarr; Payouts).</p>
    </td></tr>
  </table>
</body>
</html>`;

    const delivery = await sendEmail({ apiKey, from, to, subject, text, html });
    if (!delivery.sent) {
      console.warn(
        `[merchant-notify] delivery failed for order ${orderId} (shop ${shopId}): ${delivery.error ?? "unknown"}`,
      );
    }
    return delivery;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[merchant-notify] error for order ${orderId} (shop ${shopId}): ${message}`);
    return { sent: false, error: message };
  }
}
