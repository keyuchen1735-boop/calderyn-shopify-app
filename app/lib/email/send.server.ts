// app/lib/email/send.server.ts
//
// Generic transactional email via the Resend REST API (no SDK — one `fetch` to
// https://api.resend.com/emails). Extracted from github-digest/deliver.server.ts
// so multiple features (digest, bug reports) share one sender. Never throws;
// returns a structured result so callers can record a delivery failure (rule 12).

export interface EmailAttachment {
  filename: string;
  /** base64-encoded file content */
  content: string;
  contentType?: string;
  /** Content-ID for inline images referenced from the HTML as `cid:<id>`. */
  contentId?: string;
}

export interface DeliveryResult {
  sent: boolean;
  id?: string;
  error?: string;
}

interface ResendOk {
  id: string;
}

export async function sendEmail(opts: {
  apiKey: string;
  from: string;
  to: string | string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachment[];
  headers?: Record<string, string>;
}): Promise<DeliveryResult> {
  try {
    const payload: Record<string, unknown> = {
      from: opts.from,
      to: Array.isArray(opts.to) ? opts.to : [opts.to],
      subject: opts.subject,
      text: opts.text,
    };
    if (opts.cc && opts.cc.length) payload.cc = opts.cc;
    if (opts.replyTo) payload.reply_to = opts.replyTo;
    if (opts.html) payload.html = opts.html;
    if (opts.attachments && opts.attachments.length) {
      payload.attachments = opts.attachments.map((a) => ({
        filename: a.filename,
        content: a.content,
        ...(a.contentType ? { content_type: a.contentType } : {}),
        ...(a.contentId ? { content_id: a.contentId } : {}),
      }));
    }
    if (opts.headers && Object.keys(opts.headers).length) payload.headers = opts.headers;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { sent: false, error: `Resend ${res.status} ${res.statusText} ${detail.slice(0, 200)}` };
    }

    const data = (await res.json()) as ResendOk;
    return { sent: true, id: data?.id };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}
