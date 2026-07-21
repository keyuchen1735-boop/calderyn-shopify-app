# Claude Design System Prompt adaptation

- Source: https://github.com/Trystan-SA/claude-design-system-prompt/tree/3c3ddb07d7aa3fef051d83608596470c95cfd8fe/claude
- Commit: `3c3ddb07d7aa3fef051d83608596470c95cfd8fe`
- License: MIT; copyright 2026 Trystan Sarrade
- Local adaptation: `claude-design-3c3ddb-calderyn-1`

This is a principle-level adaptation for deterministic, server-only storefront generation and review prompts. Runtime code does not import vendor Markdown.

| Source Markdown | Runtime mapping |
|---|---|
| `claude/system-prompt.md` | Core context fidelity, content, aesthetic, hierarchy, rhythm, typography, color, accessibility, interaction, simplicity, consistency, responsive, quality, and IP guidance. Agent identity, tools, file delivery, collaboration workflow, and arbitrary JavaScript are excluded. |
| `claude/skills/accessibility-audit.md` | Review rubric for WCAG contrast, semantics, keyboard/focus, motion, forms, and browser-proof acceptance. Parallel-agent procedure is excluded. |
| `claude/skills/ai-slop-check.md` | Review rubric rejecting generic gradients, decorative emoji, arbitrary cards/fonts/colors/spacing, weak imagery, and default house styles. |
| `claude/skills/component-extract.md` | Generation guidance for repeated authored patterns, variants, states, and cross-route consistency. Filesystem inventory and handoff are excluded. |
| `claude/skills/design-system-extract.md` | Deterministic extraction from supplied recipe source, merchant brand data, and owned references. Token-file emission is excluded. |
| `claude/skills/discovery-questions.md` | No runtime question pause. Missing material context must be resolved before generation as an unsupported or clarification result. |
| `claude/skills/frontend-aesthetic-direction.md` | Concrete typography, color, density, component, imagery, and motion direction when supplied brand context is insufficient. Multi-option user selection is excluded. |
| `claude/skills/generate-variations.md` | Full-redesign planning may explore substantive axes internally, then returns one frozen direction. Merchant-visible alternatives and multi-file output are excluded. |
| `claude/skills/hierarchy-rhythm-review.md` | Review rubric for priority signals, spacing scale, grouping, repetition, and responsive reading order. Subagents are excluded. |
| `claude/skills/interaction-states-pass.md` | Review rubric for states and feedback, limited to the compiler's closed declarative interactions. Arbitrary handlers and JavaScript are excluded. |
| `claude/skills/make-a-deck.md` | Excluded; presentations, slides, speaker notes, and deck delivery are unrelated to storefront generation. |
| `claude/skills/make-a-prototype.md` | Screen, route, and state coverage informs generation; compiler output and browser proof replace prototype files and custom state code. |
| `claude/skills/make-tweakable.md` | Excluded; hidden controls, host protocols, tweak UI, persistence, and development bridges must not ship. |
| `claude/skills/polish-pass.md` | Final structured judge rubric for accessibility, aesthetics, hierarchy/rhythm, interaction states, consistency, and visible polish. |
| `claude/skills/wireframe.md` | Full-redesign plan may consider route composition internally; no merchant-visible sketches, annotations, or handoff files are produced. |

Deliberate workflow exclusions apply across the package: question pauses, subagents, filesystem-based project discovery or delivery, decks, tweak controls, tool invocation, arbitrary HTML/JavaScript, and user-driven intermediate selection. The server supplies bounded context, requests structured compiler source, and deterministically owns routing, validation, repair limits, proof, persistence, and installation.
