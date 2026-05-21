import type {
  ActionKind,
  Alert,
  AuditEntry,
  Campaign,
  GuardrailConfig,
  Integration,
  SKU,
} from "./types";

export class CalderynError extends Error {
  code: string;
  status: number;
  details: unknown;
  constructor(opts: { code: string; status: number; message: string; details?: unknown }) {
    super(opts.message);
    this.name = "CalderynError";
    this.code = opts.code;
    this.status = opts.status;
    this.details = opts.details;
  }
}

type FetchOpts = {
  signal?: AbortSignal;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | undefined>;
};

function baseUrl(): string {
  const url = process.env.CALDERYN_API_URL;
  if (!url) {
    throw new CalderynError({
      code: "BACKEND_NOT_CONFIGURED",
      status: 500,
      message: "CALDERYN_API_URL is not set",
    });
  }
  return url.replace(/\/$/, "");
}

function serviceToken(): string {
  const token = process.env.CALDERYN_SERVICE_TOKEN;
  if (!token) {
    throw new CalderynError({
      code: "BACKEND_NOT_CONFIGURED",
      status: 500,
      message: "CALDERYN_SERVICE_TOKEN is not set",
    });
  }
  return token;
}

async function request<T>(shop: string, path: string, opts: FetchOpts = {}): Promise<T> {
  const url = new URL(baseUrl() + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== "" && v !== "all") url.searchParams.set(k, v);
    }
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: opts.method ?? "GET",
      signal: opts.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${serviceToken()}`,
        "X-Shop-Domain": shop,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") throw err;
    throw new CalderynError({
      code: "NETWORK_ERROR",
      status: 0,
      message: `Failed to reach Calderyn backend: ${(err as Error).message}`,
      details: err,
    });
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? safeJson(text) : null;

  if (!response.ok) {
    const code = (payload && typeof payload === "object" && "code" in (payload as object))
      ? String((payload as { code?: unknown }).code)
      : `HTTP_${response.status}`;
    const message = (payload && typeof payload === "object" && "message" in (payload as object))
      ? String((payload as { message?: unknown }).message)
      : response.statusText || "Calderyn backend error";
    throw new CalderynError({
      code,
      status: response.status,
      message,
      details: payload,
    });
  }

  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export type AlertFilters = {
  status?: string;
  severity?: string;
  detector?: string;
};

export type ExecuteActionOpts = {
  alertId: string | null;
  kind: ActionKind;
  params: Record<string, unknown>;
  idempotencyKey: string;
};

export type IntegrationProvider = "google" | "meta" | "quickbooks";

export type OnboardingState = { step: number; done: boolean };

export function calderynClient(shop: string) {
  return {
    alerts: {
      list(filters: AlertFilters = {}, signal?: AbortSignal): Promise<Alert[]> {
        return request<Alert[]>(shop, "/v1/alerts", { signal, query: filters });
      },
      get(id: string, signal?: AbortSignal): Promise<Alert> {
        return request<Alert>(shop, `/v1/alerts/${encodeURIComponent(id)}`, { signal });
      },
    },
    audit: {
      list(signal?: AbortSignal): Promise<AuditEntry[]> {
        return request<AuditEntry[]>(shop, "/v1/audit", { signal });
      },
      undo(auditId: string, signal?: AbortSignal): Promise<AuditEntry> {
        return request<AuditEntry>(shop, `/v1/audit/${encodeURIComponent(auditId)}/undo`, {
          method: "POST",
          signal,
        });
      },
    },
    actions: {
      execute(opts: ExecuteActionOpts, signal?: AbortSignal): Promise<AuditEntry> {
        return request<AuditEntry>(shop, "/v1/actions/execute", {
          method: "POST",
          signal,
          body: {
            alert_id: opts.alertId,
            kind: opts.kind,
            params: opts.params,
            idempotency_key: opts.idempotencyKey,
          },
        });
      },
    },
    campaigns: {
      list(signal?: AbortSignal): Promise<Campaign[]> {
        return request<Campaign[]>(shop, "/v1/campaigns", { signal });
      },
    },
    skus: {
      list(signal?: AbortSignal): Promise<SKU[]> {
        return request<SKU[]>(shop, "/v1/skus", { signal });
      },
    },
    guardrails: {
      get(signal?: AbortSignal): Promise<GuardrailConfig> {
        return request<GuardrailConfig>(shop, "/v1/guardrails", { signal });
      },
      update(patch: Partial<GuardrailConfig>, signal?: AbortSignal): Promise<GuardrailConfig> {
        return request<GuardrailConfig>(shop, "/v1/guardrails", {
          method: "PATCH",
          signal,
          body: patch,
        });
      },
    },
    integrations: {
      list(signal?: AbortSignal): Promise<Record<string, Integration>> {
        return request<Record<string, Integration>>(shop, "/v1/integrations", { signal });
      },
      startOAuth(
        provider: IntegrationProvider,
        signal?: AbortSignal,
      ): Promise<{ redirectUrl: string }> {
        return request<{ redirectUrl: string }>(
          shop,
          `/v1/integrations/${provider}/oauth/start`,
          { method: "POST", signal },
        );
      },
      disconnect(provider: string, signal?: AbortSignal): Promise<void> {
        return request<void>(shop, `/v1/integrations/${encodeURIComponent(provider)}`, {
          method: "DELETE",
          signal,
        });
      },
    },
    onboarding: {
      getState(signal?: AbortSignal): Promise<OnboardingState> {
        return request<OnboardingState>(shop, "/v1/onboarding", { signal });
      },
      advance(step: number, signal?: AbortSignal): Promise<void> {
        return request<void>(shop, "/v1/onboarding/advance", {
          method: "POST",
          signal,
          body: { step },
        });
      },
    },
    internal: {
      forwardWebhook(
        path: string,
        payload: unknown,
        headers: Record<string, string> = {},
        signal?: AbortSignal,
      ): Promise<void> {
        return request<void>(shop, path, {
          method: "POST",
          signal,
          body: { headers, payload },
        });
      },
    },
  };
}

export type CalderynClient = ReturnType<typeof calderynClient>;

export { newIdempotencyKey } from "./ids";
