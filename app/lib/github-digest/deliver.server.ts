// app/lib/github-digest/deliver.server.ts
//
// Email delivery for the daily digest via the Resend REST API (no SDK dep —
// one `fetch` to https://api.resend.com/emails). Returns a structured result;
// it never throws, so the caller can record a delivery failure in the cron
// summary and surface it (rule 12) rather than 500-ing the whole route opaquely.

export interface DeliveryResult {
  sent: boolean;
  id?: string;
  error?: string;
}

interface ResendOk {
  id: string;
}

export async function deliverEmail(opts: {
  apiKey: string;
  from: string;
  to: string;
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
}): Promise<DeliveryResult> {
  try {
    const payload: Record<string, unknown> = {
      from: opts.from,
      to: [opts.to],
      subject: opts.subject,
      text: opts.text,
    };
    if (opts.cc && opts.cc.length) payload.cc = opts.cc;
    // html is preferred by clients that support it; text remains the fallback part.
    if (opts.html) payload.html = opts.html;
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
