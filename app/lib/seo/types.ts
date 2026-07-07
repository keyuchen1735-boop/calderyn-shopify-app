export interface JsonLd { "@context": "https://schema.org"; "@type": string; [k: string]: unknown; }
export type OgType = "website" | "product";
export interface SeoDraft {
  title: string;            // <title> + og:title (<= 60 chars)
  description: string;      // meta description + og:description (<= 160 chars)
  canonical: string;        // absolute http(s) URL
  ogImage: string | null;   // absolute URL or null
  ogType: OgType;
  imageAlts: string[];      // one alt per product image (generated when source alt is missing)
  jsonLd: JsonLd[];         // one or more schema.org nodes
}
export type HealthStatus = "pass" | "warn" | "fail";
export interface HealthCheck { id: string; label: string; status: HealthStatus; hint?: string; }
export interface HealthReport { score: number; checks: HealthCheck[]; }
export interface SeoIssue { field: string; message: string; }
export type AiBotName =
  | "GPTBot" | "OAI-SearchBot" | "ChatGPT-User"
  | "ClaudeBot" | "anthropic-ai" | "Claude-User"
  | "PerplexityBot" | "Perplexity-User"
  | "Google-Extended" | "CCBot" | "Amazonbot" | "Bytespider" | "cohere-ai";
