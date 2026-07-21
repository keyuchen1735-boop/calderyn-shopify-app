# Storefront Recipe Light Reset

## Outcome

Rebuild Volt, Atelier, Gilt, Ember, Roast, Fizz, Forge, Haven, and Glow as nine visibly unrelated ecommerce systems while retaining the existing compiled recipe runtime and protected commerce controls.

## Visual contract

- Every recipe uses a light primary surface and no more than three non-spacing design colors.
- Every recipe uses a different display font from the local curated font library.
- Heroes remain at most two lines and use distinct compositions and motion: Volt scan, Atelier curtain, Gilt orbit, Ember shear, Roast stack, Fizz buoyancy, Forge conveyor, Haven room wipe, Glow liquid morph.
- Product, collection, search, story, cart, checkout, account, and policy paths remain readable in the same palette.
- Mobile layouts retain visible purchase actions and avoid horizontal overflow.
- Reduced-motion users receive the same content without pinned, scrubbed, or looping movement.

## Commerce contract

The redesign does not replace commerce behavior. Product and collection repeats remain live-data bound; variantPicker, addToCart, quickViewCommerce, cartDrawer, cartLineControls, cartSummary, bundleBuilder, and checkout remain trusted runtime slots. Prices, availability, cart totals, policies, and checkout stay platform-owned.

## Verification

Recipe tests enforce the palette, font, hero, motion, route, and protected-slot contracts. Source parity, interactive contracts, typecheck, lint, build, and visual baselines must pass before the branch is pushed.
