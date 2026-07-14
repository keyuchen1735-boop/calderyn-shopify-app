# Storefront recipe design baselines

These standalone HTML files preserve the ten approved niche storefront directions from the 2026-07-13 design review. They are visual/interaction baselines for implementing versioned production recipes; they are not shipped storefront runtime artifacts.

| Template ID | Baseline |
|---|---|
| `custom-bench` | `custom-bench.html` |
| `commons-index` | `commons-index.html` |
| `soft-chemistry` | `soft-chemistry.html` |
| `companion-field-guide` | `companion-field-guide.html` |
| `daily-protocol` | `daily-protocol.html` |
| `room-modes` | `room-modes.html` |
| `rep-rest` | `rep-rest.html` |
| `diagnostic-deck` | `diagnostic-deck.html` |
| `ritual-almanac` | `ritual-almanac.html` |
| `broadcast-patch-bay` | `broadcast-patch-bay.html` |

The eleventh approved recipe, Atelier Grid, is preserved at `public/atelier-grid/index.html` with local owned image assets.

## Production-use boundary

- Temporary remote photographs and web-font imports in these prototypes are reference-only. They must be replaced by merchant catalog media, generated owned media, explicitly licensed owned assets, and curated self-hosted fonts before a recipe is activated.
- Prototype JavaScript demonstrates intended behavior. Production implementations must express it through the validated interaction manifest and trusted storefront runtime from `docs/superpowers/specs/2026-07-13-interactive-storefront-recipes-and-ai-compiler-design.md`.
- Placeholder catalog copy, prices, availability, cart state, and checkout details are illustrative. Production recipes bind live shop-scoped presentation data and trusted commerce islands.
- A material design change creates a new recipe version and new fixed-fixture visual baselines; these files remain the version-1 direction record.
