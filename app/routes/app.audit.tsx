import { useMemo, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";
import { useEmbeddedNavigate } from "../lib/embedded-nav";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Banner, BlockStack, Box, Button, Card, Page, Text } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { calderynClient, type CalderynError } from "~/lib/calderyn.server";
import { fmtMoney, fmtRelTime, fmtAbsTime } from "~/lib/format";
import { recovered as recoveredOf } from "~/lib/recovered";
import { ACTION_LABELS, COST_SOURCE_LABELS } from "~/lib/labels";
import { auditLegibility } from "~/lib/audit-legibility";
import { stateDiff } from "~/lib/audit-state-diff";
import { useActionToast } from "~/lib/toast";
import type { AuditEntry } from "~/lib/types";

type LoaderPayload = {
  audit: AuditEntry[];
  error: { code: string; message: string } | null;
};

type ActionPayload = {
  ok: boolean;
  toast?: { message: string; isError?: boolean };
  error?: { code: string; message: string };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  try {
    const audit = await client.audit.list(request.signal);
    return json<LoaderPayload>({ audit, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      audit: [],
      error: { code: e.code ?? "ERROR", message: e.message },
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const auditId = String(formData.get("auditId") || "");

  if (intent !== "undo" || !auditId) {
    return json<ActionPayload>(
      {
        ok: false,
        error: { code: "INVALID_INTENT", message: "Unknown intent" },
        toast: { message: "Unknown intent", isError: true },
      },
      { status: 400 },
    );
  }

  try {
    await client.audit.undo(auditId, request.signal);
    return json<ActionPayload>({
      ok: true,
      toast: { message: "Action undone" },
    });
  } catch (err) {
    const e = err as CalderynError;
    return json<ActionPayload>(
      {
        ok: false,
        error: { code: e.code ?? "ERROR", message: e.message },
        toast: { message: e.message, isError: true },
      },
      { status: e.status >= 400 && e.status < 600 ? e.status : 500 },
    );
  }
};

/* ─────────────────────────── icons ─────────────────────────── */
// One small inline SVG per action shape. Stroke icons (no external icon set on
// this surface so the page is self-contained); chosen from the action_kind, with
// reversal rows always reading as an "undo" regardless of the original kind.
type IconName = "pause" | "play" | "inventory" | "po" | "undo" | "ship" | "clock";

function iconFor(a: AuditEntry): IconName {
  if (a.undo_of) return "undo";
  switch (a.action_kind) {
    case "pause_campaign":
    case "reduce_campaign_budget":
    case "reallocate_budget":
    case "exclude_geo":
      return "pause";
    case "resume_campaign":
    case "increase_campaign_budget":
      return "play";
    case "reallocate_inventory":
      return "inventory";
    case "create_po_draft":
      return "po";
    case "raise_free_ship_threshold":
    case "exclude_sku_free_ship":
      return "ship";
    default:
      return "clock";
  }
}

function ActionIcon({ name }: { name: IconName }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "pause":
      return (
        <svg {...common}>
          <path d="M9 5v14M15 5v14" />
        </svg>
      );
    case "play":
      return (
        <svg {...common}>
          <path d="M7 5l12 7-12 7V5Z" />
        </svg>
      );
    case "inventory":
      return (
        <svg {...common}>
          <path d="M3 7l9-4 9 4-9 4-9-4Z" />
          <path d="M3 7v10l9 4 9-4V7" />
          <path d="M12 11v10" />
        </svg>
      );
    case "po":
      return (
        <svg {...common}>
          <rect x="5" y="3" width="14" height="18" rx="2" />
          <path d="M9 8h6M9 12h6M9 16h4" />
        </svg>
      );
    case "undo":
      return (
        <svg {...common}>
          <path d="M9 14 4 9l5-5" />
          <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
        </svg>
      );
    case "ship":
      return (
        <svg {...common}>
          <path d="M3 13h13V6H3zM16 9h4l1 4v3h-5" />
          <circle cx="7.5" cy="18" r="1.6" />
          <circle cx="17.5" cy="18" r="1.6" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4l3 2" />
        </svg>
      );
  }
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span className="aux-chev" data-open={open}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </span>
  );
}

/* ─────────────────────────── buckets ─────────────────────────── */
type Bucket = "Today" | "This week" | "Earlier";

function bucketOf(iso: string, now: number): Bucket {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "Earlier";
  const days = (now - t) / 86_400_000;
  if (days < 1) return "Today";
  if (days < 7) return "This week";
  return "Earlier";
}

/* ─────────────────────────── CSV export ─────────────────────────── */
function buildCsv(rows: AuditEntry[]): string {
  const head = ["Time", "Action", "Target", "Mode", "Impact (USD)", "Status", "Action ID"];
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = rows.map((a) => {
    const leg = auditLegibility(a);
    const label = a.undo_of ? `Reversed — ${ACTION_LABELS[a.action_kind] ?? a.action_kind}` : ACTION_LABELS[a.action_kind] ?? a.action_kind;
    const impact = ((a.dollar_impact_at_exec || 0) / 100).toFixed(2);
    return [
      fmtAbsTime(a.created_at),
      label,
      a.target,
      leg.mode === "auto" ? "Auto" : "Manual",
      impact,
      a.outcome,
      a.id,
    ]
      .map((c) => esc(String(c)))
      .join(",");
  });
  return [head.map(esc).join(","), ...lines].join("\r\n");
}

/* ─────────────────────────── one timeline row ─────────────────────────── */
function AuditRow({ a, submitting }: { a: AuditEntry; submitting: boolean }) {
  const [open, setOpen] = useState(false);
  const leg = auditLegibility(a);
  const diff = stateDiff(a.action_kind, a.pre_state, a.post_state);
  const actionLabel = ACTION_LABELS[a.action_kind] ?? a.action_kind;
  const title = a.undo_of ? `Reversed — ${actionLabel}` : actionLabel;

  const ok = a.outcome === "succeeded";
  const retrying = a.outcome === "retrying";
  const impact = a.dollar_impact_at_exec || 0;
  const isReversal = Boolean(a.undo_of) || impact < 0;

  const railClass = !ok ? (retrying ? "aux-rail-warn" : "aux-rail-fail") : isReversal ? "aux-rail-mute" : "aux-rail-ok";

  // The booked-margin caption + detail describe a genuine recovery — gate to
  // positive, non-reversal rows (matches the dashboard's `> 0 && !undone`).
  const showImpactCaption = impact > 0 && !a.undo_of;
  let impactText = "";
  let impactClass = "aux-impact-mute";
  if (impact > 0 && !a.undo_of) {
    impactText = `+${fmtMoney(impact)} recovered`;
    impactClass = "aux-impact-ok";
  } else if (impact < 0 || a.undo_of) {
    impactText = `−${fmtMoney(Math.abs(impact))} reversed`;
    impactClass = "aux-impact-mute";
  }

  const canUndo = a.undo_eligible && !a.undo_of;
  const hasPoPdf =
    a.action_kind === "create_po_draft" && a.outcome === "succeeded" && Boolean(a.post_state?.po);

  const statusLabel = ok ? "Succeeded" : retrying ? "Retrying" : "Failed";
  const statusClass = ok ? "aux-pill-ok" : retrying ? "aux-pill-warn" : "aux-pill-fail";

  return (
    <div className="aux-row">
      <div className={`aux-rail ${railClass}`} />
      <div className="aux-row-body">
        <button
          type="button"
          className="aux-row-head"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="aux-icon">
            <ActionIcon name={iconFor(a)} />
          </span>
          <span className="aux-row-main">
            <span className="aux-row-title">{title}</span>
            <span className="aux-row-sub">
              {a.target} · {fmtRelTime(a.created_at)}
            </span>
          </span>
          {impactText && <span className={`aux-impact ${impactClass}`}>{impactText}</span>}
          <span className={`aux-pill ${statusClass}`}>{statusLabel}</span>
          <Chevron open={open} />
        </button>

        {open && (
          <div className="aux-detail">
            <div className="aux-detail-grid">
              <div className="aux-field">
                <div className="aux-field-label">Why this fired</div>
                <div className="aux-field-value">{leg.whyDetail ?? leg.why}</div>
              </div>
              <div className="aux-field">
                <div className="aux-field-label">Triggered by</div>
                <div className="aux-field-value">{leg.actorDisplay}</div>
              </div>
              <div className="aux-field">
                <div className="aux-field-label">When</div>
                <div className="aux-field-value">{fmtAbsTime(a.created_at)}</div>
              </div>
              <div className="aux-field">
                <div className="aux-field-label">Action ID</div>
                <div className="aux-field-value aux-mono">{a.id}</div>
              </div>
              {a.failure_reason && (
                <div className="aux-field aux-field-wide">
                  <div className="aux-field-label">Why it didn&apos;t run</div>
                  <div className="aux-field-value">{a.failure_reason}</div>
                </div>
              )}
              {showImpactCaption && (
                <div className="aux-field aux-field-wide">
                  <div className="aux-field-label">Booked margin</div>
                  <div className="aux-field-value">
                    {fmtMoney(impact)} · {leg.marginBasisLabel}
                  </div>
                </div>
              )}
            </div>

            {leg.costLineage.length > 0 && (
              <div className="aux-lineage">
                <span className="aux-field-label">Cost lineage</span>
                {leg.costLineage.map((s, i) => (
                  <span key={i} className="aux-tag" data-warn={s.source === "unavailable"}>
                    {`${s.kind === "ad_spend" ? "Ad spend" : s.kind === "cogs" ? "COGS" : "Price"}: ${COST_SOURCE_LABELS[s.source] ?? s.source}`}
                  </span>
                ))}
              </div>
            )}

            {diff.length > 0 && (
              <div className="aux-diff">
                <span className="aux-field-label">Before → after</span>
                <div className="aux-diff-grid">
                  {diff.map((r) => (
                    <div key={r.label} className="aux-diff-cell">
                      <div className="aux-field-label">{r.label}</div>
                      <div className="aux-field-value aux-strong">
                        {r.before != null && r.after != null ? `${r.before} → ${r.after}` : r.after ?? r.before}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(canUndo || hasPoPdf) && (
              <div className="aux-row-actions">
                {canUndo && (
                  <Form method="post">
                    <input type="hidden" name="intent" value="undo" />
                    <input type="hidden" name="auditId" value={a.id} />
                    <Button submit variant="secondary" loading={submitting} disabled={submitting}>
                      Undo this action
                    </Button>
                  </Form>
                )}
                {hasPoPdf && <DownloadPoButton auditId={a.id} />}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

type StatusFilter = "all" | "ok" | "failed";

export default function Audit() {
  const navigate = useEmbeddedNavigate();
  const loaderData = useLoaderData<typeof loader>();
  // Remix's useLoaderData Jsonify wrapper marks AuditEntry's nullable fields
  // optional, but the runtime objects ARE full AuditEntry rows and the
  // legibility/state-diff/CSV helpers all tolerate the null fields — widen back
  // so those helpers type-check (justification per the no-`any` rule).
  const audit = loaderData.audit as unknown as AuditEntry[];
  const error = loaderData.error;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  useActionToast(actionData);

  const [filter, setFilter] = useState<StatusFilter>("all");

  const now = Date.now();

  const filtered = useMemo(
    () =>
      audit.filter((a) =>
        filter === "all"
          ? true
          : filter === "ok"
            ? a.outcome === "succeeded"
            : a.outcome !== "succeeded",
      ),
    [audit, filter],
  );

  const groups = useMemo(() => {
    const order: Bucket[] = ["Today", "This week", "Earlier"];
    return order
      .map((label) => ({
        label,
        items: filtered.filter((a) => bucketOf(a.created_at, now) === label),
      }))
      .filter((g) => g.items.length > 0);
  }, [filtered, now]);

  const exportCsv = () => {
    const csv = buildCsv(audit);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "calderyn-action-history.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  if (audit.length === 0) {
    return (
      <Page
        title="Action history"
        backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      >
        {error && (
          <Box paddingBlockEnd="400">
            <Banner tone="critical" title="Couldn't load audit log">
              <p>{error.message}</p>
            </Banner>
          </Box>
        )}
        <Card>
          <Box padding="600">
            <BlockStack gap="300" inlineAlign="center">
              <Text as="p" variant="headingMd">
                No actions yet
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Every action Calderyn takes — and your one-click Undo for each — is recorded
                here. Approve an alert recommendation or pause a campaign to log your first.
              </Text>
              <div className="aux-empty-actions">
                <Button variant="primary" onClick={() => navigate("/app/alerts")}>
                  Open alerts
                </Button>
                <Button onClick={() => navigate("/app/campaigns")}>Manage campaigns</Button>
              </div>
            </BlockStack>
          </Box>
        </Card>
      </Page>
    );
  }

  const succeeded = audit.filter((a) => a.outcome === "succeeded").length;
  const successRate = Math.round((succeeded / audit.length) * 100);
  // Shared with the home tile and the web dashboard (app/lib/recovered.ts):
  // succeeded actions, undo rows excluded.
  const recovered = recoveredOf(audit).cents;

  const showingText =
    filtered.length === audit.length
      ? `${audit.length} actions`
      : `Showing ${filtered.length} of ${audit.length} actions`;

  const CHIPS: { key: StatusFilter; label: string; dot?: string }[] = [
    { key: "all", label: "All" },
    { key: "ok", label: "Succeeded", dot: "#1a7f4f" },
    { key: "failed", label: "Failed", dot: "#b3300f" },
  ];

  return (
    <Page
      fullWidth
      title="Action history"
      subtitle="Every action Calderyn ran for you, newest first. Click any row for the details. Kept for 90 days."
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      secondaryActions={[{ content: "Export CSV", onAction: exportCsv }]}
    >
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" title="Couldn't load audit log">
            <p>{error.message}</p>
          </Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical" title="Undo failed">
            <p>{actionData.error.message}</p>
          </Banner>
        )}

        {/* KPI strip */}
        <div className="aux-kpis">
          <div className="aux-kpi">
            <div className="aux-kpi-label">Actions run</div>
            <div className="aux-kpi-value">{audit.length}</div>
            <div className="aux-kpi-caption">in the last 90 days</div>
          </div>
          <div className="aux-kpi">
            <div className="aux-kpi-label">Success rate</div>
            <div className="aux-kpi-rate">
              <span className="aux-kpi-value">{successRate}%</span>
              <span className="aux-kpi-sub">
                {succeeded} of {audit.length}
              </span>
            </div>
            <div className="aux-bar">
              <div className="aux-bar-fill" style={{ width: `${successRate}%` }} />
            </div>
          </div>
          <div className="aux-kpi aux-kpi-accent">
            <div className="aux-kpi-label">Money recovered</div>
            <div className="aux-kpi-value aux-accent">{fmtMoney(recovered)}</div>
            <div className="aux-kpi-caption">from actions that succeeded</div>
          </div>
        </div>

        {/* Filter chips */}
        <div className="aux-toolbar">
          <div className="aux-chips">
            {CHIPS.map((c) => (
              <button
                key={c.key}
                type="button"
                className="aux-chip"
                data-on={filter === c.key}
                onClick={() => setFilter(c.key)}
              >
                {c.dot && <span className="aux-chip-dot" style={{ background: c.dot }} />}
                {c.label}
              </button>
            ))}
          </div>
          <span className="aux-showing">{showingText}</span>
        </div>

        {/* Timeline */}
        {groups.length === 0 ? (
          <Card>
            <Box padding="500">
              <BlockStack gap="100" inlineAlign="center">
                <Text as="p" variant="bodySm" tone="subdued">
                  No actions match this filter.
                </Text>
              </BlockStack>
            </Box>
          </Card>
        ) : (
          <div className="aux-timeline">
            {groups.map((g) => (
              <div key={g.label} className="aux-group">
                <div className="aux-group-label">{g.label}</div>
                <Card padding="0">
                  <div className="aux-group-rows">
                    {g.items.map((a) => (
                      <AuditRow key={a.id} a={a} submitting={submitting} />
                    ))}
                  </div>
                </Card>
              </div>
            ))}
          </div>
        )}
      </BlockStack>
    </Page>
  );
}

function DownloadPoButton({ auditId }: { auditId: string }) {
  const shopify = useAppBridge();
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    setDownloading(true);
    try {
      // Embedded iframe: a plain <a href> document navigation won't carry the
      // session token. App Bridge patches global fetch with it, so fetch the
      // bytes and hand them to the browser as a blob download.
      const res = await fetch(`/app/audit/${auditId}/po.pdf`);
      if (!res.ok) throw new Error(`PDF download failed (${res.status})`);
      const filename =
        res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ??
        "purchase-order.pdf";
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      // Defer revoke: Safari can abort the download if the URL is revoked
      // before the browser's download task has grabbed the blob.
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (err) {
      shopify.toast.show((err as Error).message || "PDF download failed", {
        isError: true,
        duration: 5000,
      });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Button variant="plain" loading={downloading} onClick={download}>
      Download PDF
    </Button>
  );
}
