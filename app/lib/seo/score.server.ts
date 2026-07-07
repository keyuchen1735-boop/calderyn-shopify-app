// Rubric-based health score (0-100) shown per page in the dashboard (Plan B). Each check is
// equal-weighted; a "warn" counts as half credit. Kept deterministic for stable UI + tests.
import type { HealthCheck, HealthReport, SeoDraft } from "./types";
import { validateDraft } from "./validator.server";

export function scoreDraft(draft: SeoDraft): HealthReport {
  const issues = validateDraft(draft);
  const has = (field: string) => !issues.some((i) => i.field === field);
  const altsOk = draft.imageAlts.length === 0 || draft.imageAlts.every((a) => a.trim().length > 0);
  const hasProduct = draft.jsonLd.some((n) => n["@type"] === "Product" || n["@type"] === "CollectionPage" || n["@type"] === "Organization");
  const hasBreadcrumb = draft.jsonLd.some((n) => n["@type"] === "BreadcrumbList" || n["@type"] === "WebSite");

  const checks: HealthCheck[] = [
    { id: "title", label: "Page title", status: has("title") ? "pass" : "fail", hint: has("title") ? undefined : "Title should be 10 to 60 characters." },
    { id: "description", label: "Meta description", status: has("description") ? "pass" : "fail", hint: has("description") ? undefined : "Description should be 50 to 160 characters." },
    { id: "canonical", label: "Canonical URL", status: has("canonical") ? "pass" : "fail", hint: has("canonical") ? undefined : "Needs an absolute page URL." },
    { id: "ogImage", label: "Share image", status: draft.ogImage ? "pass" : "fail", hint: draft.ogImage ? undefined : "Add a product or logo image so links preview nicely." },
    { id: "schema", label: "Structured data", status: has("jsonLd") && hasProduct ? "pass" : "fail", hint: has("jsonLd") && hasProduct ? undefined : "Structured data is missing or invalid." },
    { id: "breadcrumb", label: "Breadcrumbs / site links", status: hasBreadcrumb ? "pass" : "warn", hint: hasBreadcrumb ? undefined : "Breadcrumb links help search engines understand structure." },
    { id: "alt", label: "Image alt text", status: altsOk ? "pass" : "fail", hint: altsOk ? undefined : "Every image needs descriptive alt text." },
  ];

  const credit = checks.reduce((sum, c) => sum + (c.status === "pass" ? 1 : c.status === "warn" ? 0.5 : 0), 0);
  const score = Math.round((credit / checks.length) * 100);
  return { score, checks };
}
