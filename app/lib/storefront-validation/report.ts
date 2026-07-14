import type { BrowserDiagnostic, BrowserProofReport } from "../storefront-ai/contracts";

export type StorefrontProofViewportName = "mobile" | "tablet" | "desktop";

export interface StorefrontBrowserDiagnostic extends BrowserDiagnostic {
  artifactId?: string;
  viewport?: StorefrontProofViewportName;
  severity?: "critical" | "serious" | "moderate";
  detail?: Record<string, unknown>;
}

export interface StorefrontBrowserMetrics {
  routeHtmlCssBytes: Partial<Record<BrowserDiagnostic["routeId"], number>>;
  interactionBytes: Partial<Record<BrowserDiagnostic["routeId"], number>>;
  fullBundleBytes: number;
  maxCumulativeLayoutShift?: number;
  maxLargestContentfulPaintMs?: number;
  maxLongTaskMs?: number;
}

export interface StorefrontBrowserProofReport extends BrowserProofReport {
  diagnostics: StorefrontBrowserDiagnostic[];
  metrics?: StorefrontBrowserMetrics;
  cases?: number;
}

function diagnosticKey(value: StorefrontBrowserDiagnostic): string {
  return [value.artifactId ?? "", value.routeId, value.viewport ?? "", value.regionId ?? "", value.code, value.message].join("\u0000");
}

export function createBrowserProofReport(input: {
  diagnostics: readonly StorefrontBrowserDiagnostic[];
  screenshots: readonly string[];
  browserMs: number;
  metrics?: StorefrontBrowserMetrics;
  cases?: number;
}): StorefrontBrowserProofReport {
  const diagnostics = [...new Map(input.diagnostics.map((entry) => [diagnosticKey(entry), entry])).values()]
    .sort((left, right) => diagnosticKey(left).localeCompare(diagnosticKey(right)));
  const screenshots = [...new Set(input.screenshots)].sort();
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    screenshots,
    browserMs: Math.max(0, Math.round(input.browserMs)),
    ...(input.metrics ? { metrics: input.metrics } : {}),
    ...(input.cases === undefined ? {} : { cases: input.cases }),
  };
}

export function mergeBrowserProofReports(reports: readonly StorefrontBrowserProofReport[]): StorefrontBrowserProofReport {
  return createBrowserProofReport({
    diagnostics: reports.flatMap((report) => report.diagnostics),
    screenshots: reports.flatMap((report) => report.screenshots),
    browserMs: reports.reduce((sum, report) => sum + report.browserMs, 0),
    cases: reports.reduce((sum, report) => sum + (report.cases ?? 0), 0),
  });
}
