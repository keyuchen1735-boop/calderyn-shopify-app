# Product

## Register

product

## Users
Shopify merchants (small/mid-size DTC stores) running their business from the Shopify admin. They are not data analysts; they want plain-English answers about inventory, ads, and money. Calderyn is embedded inside the Shopify admin, so users are mid-task: checking stock, reacting to alerts, reviewing ad spend.

## Product Purpose
Calderyn is an AI ops copilot for Shopify stores: it watches inventory, sales velocity, and ad campaigns, raises plain-language alerts, and proposes (guardrailed) actions. Success = a merchant trusts the numbers at a glance and acts on alerts without needing to interpret jargon.

## Brand Personality
Calm, trustworthy, plain-spoken. Premium = clean Swiss/flat, never decorative AI aesthetics. Jargon is baby-versioned to plain language with technical terms available on hover.

## Anti-references
- AI-glow / gradient-backdrop "AI product" styling (explicitly rejected by the founder).
- Dashboard-as-art: dense hero metrics, decorative charts.
- Anything that fights Polaris; the app must feel native to the Shopify admin.

## Design Principles
1. Feel native to Shopify admin: Polaris primitives first, bespoke CSS only where Polaris can't express it (`.cdn-` layer).
2. Plain language over jargon; precise terms live in tooltips.
3. Numbers are the product: tabular figures, right-aligned, semantic tones (critical/caution) only when they mean something.
4. Restrained color; accent conveys state, never decoration.
5. Two surfaces, one contract: every merchant-facing feature here mirrors into the Calderyn web dashboard.

## Accessibility & Inclusion
WCAG AA contrast, keyboard-operable sorting/controls, `prefers-reduced-motion` alternatives for all animation (already established in calderyn.css).
