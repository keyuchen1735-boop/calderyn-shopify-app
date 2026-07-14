# Storefront runtime 1 rollout

Runtime 1 storefront releases are immutable bundles. Database migrations and code deploy inertly; none of the four switches below may be inferred from another switch.

## Preflight

1. Apply the storefront release, asset, audit, and logical-asset-key migrations in the database test environment, then production.
2. Deploy code with `STOREFRONT_BUNDLE_READ=0`, `STOREFRONT_RECIPE_BUILD=0`, `STOREFRONT_BUNDLE_PUBLISH=0`, and `STOREFRONT_CUSTOM_BUILD=0`.
3. Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run verify:client-bundle`, and `node scripts/verify-storefront-bundles.mjs` against the exact release commit.
4. Confirm the screenshot manifest contains all eleven recipe IDs at `390x844`, `768x1024`, and `1440x1000`. Baselines are updated only through `node scripts/verify-storefront-bundles.mjs --update-baselines` during an approved visual change.

## Enablement order

| Step | Switch | Audience | Required observation |
| --- | --- | --- | --- |
| 1 | `STOREFRONT_BUNDLE_READ=1` | Internal shops, then merchant canary | Render/CSP/commerce bridge errors, cache isolation, checkout starts and completion |
| 2 | `STOREFRONT_RECIPE_BUILD=1` | Same cohort | Resolver accuracy, build failure rate, browser diagnostics, install conflicts |
| 3 | `STOREFRONT_BUNDLE_PUBLISH=1` | Same cohort | Publish/rollback success, pointer conflicts, checkout conversion |
| 4 | `STOREFRONT_CUSTOM_BUILD=1` | Internal custom quota, then canary | Model/image/browser spend, novelty and proof failure rates, repair rate, wall time |

Advance only after the current cohort has a complete recipe build/publish/rollback smoke test, cart/search/checkout proof in preview and public modes, and no cross-shop or release-pointer invariant failure. Keep the preceding switches independent and enabled; never replace the sequence with one aggregate flag.

## Audit and alert surface

Generation and edit audits retain the authoritative routing resolution, bounded catalog evidence snapshot and fingerprint, compiler diagnostics, browser diagnostics and screenshot hashes, changed routes/regions, provider/token/image/browser usage, final artifact hash, installed version, and rollback target. Browser proof failures are pass/fail validation failures and do not install a draft.

Each production browser proof is cancellable through an `AbortSignal` and has a 60-second per-artifact deadline by default. Callers may supply a tighter `timeoutMs`; the verifier fails closed on cancellation or timeout.

Alert and stop rollout on any of the following:

- cross-shop data, asset, cache, or release-pointer evidence;
- browser proof failure, CSP violation, missing owned asset, unresolved binding, dead internal link, or protected commerce hit-test failure;
- increased render/commerce bridge errors or checkout conversion regression;
- generation failure, repair, wall-time, token, image, or browser spend outside the approved canary budget;
- publish/rollback conflicts or unsupported runtime/profile errors.

## Rollback

Disable the newest writer switch first. A kill switch blocks new work; it does not mutate installed releases or route merchants into legacy StoreGen. Use immutable release history to restore the last validated compatible bundle. If runtime support is lost, select the newest compatible retained history entry and alert operators. Never blank the storefront and never reactivate a historical legacy experiment.

After rollback, rerun the browser verifier and smoke one recipe, one custom bundle, one deterministic edit, one structural edit, undo, cart/search, and checkout before resuming the rollout.
