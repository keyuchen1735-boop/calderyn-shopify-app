import { useEffect } from "react";
import type { CompiledStorefrontRouteId, RouteArtifact, StorefrontBundleV1, StoreTemplateId } from "~/lib/storefront-bundle/types";
import type { PublicPresentationData } from "./public-data.server";
import { hydrateStorefront } from "./hydrate";
import type { StorefrontRuntimeHandle } from "./hydrate";
import type { CommerceIntent, CommerceMountContext, ResolvedRouteTarget, RuntimeAdapters } from "./actions";
import { canonicalizeStorefrontLinePersonalization, type StorefrontLinePersonalization } from "./trusted-slots";

type RuntimeMode = "public" | "preview";
export type RuntimeFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function hrefFor(target: ResolvedRouteTarget, mode: RuntimeMode, previewTemplateId?: StoreTemplateId): string {
  if (mode === "preview") {
    if (target.routeId === "account" || target.routeId === "policy") return "#";
    const query = new URLSearchParams({ route: target.routeId });
    if (previewTemplateId) query.set("template", previewTemplateId);
    if (typeof target.params.handle === "string") query.set("handle", target.params.handle);
    if (typeof target.params.query === "string") query.set("q", target.params.query);
    return `/dashboard/store/preview?${query.toString()}`;
  }
  const base: Record<ResolvedRouteTarget["routeId"], string> = {
    home: "/storefront", collection: "/storefront/collections", product: "/storefront/products",
    search: "/storefront/search", cart: "/storefront/cart", checkout: "/storefront/checkout",
    collections: "/storefront/collections", story: "/storefront/story", notFound: "/storefront",
    account: "/storefront/account", policy: "/storefront/policies",
  };
  let href = base[target.routeId];
  if ((target.routeId === "product" || target.routeId === "collection") && typeof target.params.handle === "string") {
    href += `/${encodeURIComponent(target.params.handle)}`;
  } else if (target.routeId === "policy" && typeof target.params.policyId === "string") {
    href += `/${encodeURIComponent(target.params.policyId)}`;
  } else if (target.routeId === "search" && typeof target.params.query === "string") {
    href += `?q=${encodeURIComponent(target.params.query)}`;
  }
  return href;
}

function publicCommerceRequest(intent: CommerceIntent): [string, Record<string, unknown>] | null {
  if (intent.type === "cart.addBundle") return ["/storefront/api/cart/add-bundle", {
    lines: intent.lines.map(({ variantId, quantity }) => ({ variantId, quantity })),
  }];
  if (intent.type === "cart.add") return ["/storefront/api/cart/add", {
    variantId: intent.variantId,
    quantity: intent.quantity,
    ...(intent.personalization === undefined ? {} : {
      personalization: canonicalizeStorefrontLinePersonalization(intent.personalization),
    }),
    ...(intent.sellingPlanId === undefined ? {} : { sellingPlanId: intent.sellingPlanId }),
  }];
  if (intent.type === "cart.quantity") return ["/storefront/api/cart/quantity", { lineId: intent.lineId, quantity: intent.quantity }];
  if (intent.type === "cart.remove") return ["/storefront/api/cart/remove", { lineId: intent.lineId }];
  if (intent.type === "cart.clear") return ["/storefront/api/cart/clear", {}];
  return null;
}

function previewCommerceBody(intent: CommerceIntent): FormData | null {
  const body = new FormData();
  if (intent.type === "cart.add") {
    body.set("intent", "add"); body.set("variantId", intent.variantId); body.set("quantity", String(intent.quantity));
  } else if (intent.type === "cart.quantity") {
    body.set("intent", "quantity"); body.set("lineId", intent.lineId); body.set("quantity", String(intent.quantity));
  } else if (intent.type === "cart.remove") {
    body.set("intent", "remove"); body.set("lineId", intent.lineId);
  } else if (intent.type === "cart.clear") body.set("intent", "clear");
  else if (intent.type === "checkout.start") body.set("intent", "checkout");
  else return null;
  return body;
}

function rgb(value: string): [number, number, number] | null {
  const normalized = value.trim();
  const hex = normalized.match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
  if (hex) {
    const expanded = hex.length === 3 ? [...hex].map((part) => `${part}${part}`).join("") : hex;
    return [Number.parseInt(expanded.slice(0, 2), 16), Number.parseInt(expanded.slice(2, 4), 16), Number.parseInt(expanded.slice(4, 6), 16)];
  }
  const functional = normalized.match(/^(rgb|rgba)\(([^)]+)\)$/i);
  if (!functional) return null;
  const channels = functional[2].match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (channels.length !== (functional[1].toLowerCase() === "rgba" ? 4 : 3)) return null;
  if (channels.length === 4 && channels[3] < 1) return null;
  return channels.slice(0, 3).every((channel) => channel >= 0 && channel <= 255)
    ? channels.slice(0, 3) as [number, number, number]
    : null;
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  const linear = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function contrastRatio(left: [number, number, number], right: [number, number, number]): number {
  const leftLuminance = relativeLuminance(left);
  const rightLuminance = relativeLuminance(right);
  return (Math.max(leftLuminance, rightLuminance) + 0.05) / (Math.min(leftLuminance, rightLuminance) + 0.05);
}

function trustedCommerceStyle({ host, shadowRoot, slot }: CommerceMountContext, squareAccentCommerce: boolean): HTMLStyleElement {
  const ownerDocument = host.ownerDocument;
  const computedHost = ownerDocument.defaultView?.getComputedStyle(host);
  const commerceColor = (name: string) => {
    let value = computedHost?.getPropertyValue(name).trim() ?? "";
    const tokenReference = value.match(/^var\(\s*(--[\w-]+)\s*\)$/)?.[1];
    if (tokenReference) value = computedHost?.getPropertyValue(tokenReference).trim() ?? "";
    return rgb(value) ? value : "";
  };
  const colors = slot.themeTokenIds.flatMap((tokenId) => {
    const color = computedHost?.getPropertyValue(`--${tokenId}`).trim() ?? "";
    return rgb(color) ? [color] : [];
  });
  let surface = "rgb(20, 22, 19)";
  let foreground = "rgb(255, 255, 255)";
  let bestContrast = 0;
  for (const left of colors) {
    for (const right of colors) {
      const leftRgb = rgb(left);
      const rightRgb = rgb(right);
      if (!leftRgb || !rightRgb) continue;
      const leftLuminance = relativeLuminance(leftRgb);
      const rightLuminance = relativeLuminance(rightRgb);
      const contrast = contrastRatio(leftRgb, rightRgb);
      if (contrast > bestContrast) {
        bestContrast = contrast;
        [surface, foreground] = leftLuminance < rightLuminance ? [left, right] : [right, left];
      }
    }
  }
  const recipeSurface = commerceColor("--commerce-surface");
  const recipeForeground = commerceColor("--commerce-foreground");
  const recipeSurfaceRgb = rgb(recipeSurface);
  const recipeForegroundRgb = rgb(recipeForeground);
  if (recipeSurfaceRgb && recipeForegroundRgb && contrastRatio(recipeSurfaceRgb, recipeForegroundRgb) >= 4.5) {
    [surface, foreground] = [recipeSurface, recipeForeground];
  }
  const accent = commerceColor("--commerce-accent") || (squareAccentCommerce && slot.themeTokenIds.includes("yellow")
    ? computedHost?.getPropertyValue("--yellow").trim() ?? ""
    : "");
  const accentForeground = commerceColor("--commerce-accent-foreground")
    || (computedHost?.getPropertyValue("--ink").trim() ?? "");
  const accentRgb = rgb(accent);
  const accentForegroundRgb = rgb(accentForeground);
  const buttonTheme = accentRgb && accentForegroundRgb && contrastRatio(accentRgb, accentForegroundRgb) >= 4.5
    ? `background:${accent};color:${accentForeground};border-color:${accentForeground};text-transform:uppercase`
    : "";
  const style = ownerDocument.createElement("style");
  style.nonce = ownerDocument.querySelector<HTMLStyleElement>("style[nonce]")?.nonce ?? "";
  style.textContent = `:host{display:block;min-width:44px;min-height:44px;font:inherit;color:${foreground}}:host([hidden]){display:none!important}div{display:flex;align-items:center;gap:.5rem}label{display:grid;gap:.25rem}button,select,input,textarea{min-width:44px;min-height:44px;padding:.65rem .9rem;border:1px solid ${foreground};border-radius:${squareAccentCommerce ? "0" : ".2rem"};background:${surface};color:${foreground};font:inherit}button{cursor:pointer;font-weight:700;${buttonTheme}}button:disabled{cursor:not-allowed;opacity:.65}input{width:5.5rem}textarea{min-width:min(20rem,100%);resize:vertical}button:focus-visible,select:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid ${foreground};outline-offset:2px}`;
  return style;
}

export function createRuntimeAdapters(input: {
  mode: RuntimeMode;
  previewTemplateId?: StoreTemplateId;
  squareAccentCommerce?: boolean;
  data?: PublicPresentationData;
  fetcher?: RuntimeFetcher;
  refresh?: () => void;
  locationAssign?: (href: string) => void;
}): RuntimeAdapters {
  const fetcher = input.fetcher ?? fetch;
  const refresh = input.refresh ?? (() => globalThis.window?.location.reload());
  const locationAssign = input.locationAssign ?? ((href: string) => globalThis.window?.location.assign(href));
  let selectedVariant = input.data?.product?.variants.find((entry) => entry.available) ?? null;
  const sellingPlanRefreshers = new Set<() => void>();
  const productById = (productId: string) => {
    const products = [
      input.data?.product,
      ...(input.data?.featuredProducts ?? []),
      ...(input.data?.collection?.products ?? []),
      ...(input.data?.search?.results ?? []),
      ...(input.data?.relatedProducts ?? []),
    ];
    return products.find((product) => product?.id === productId) ?? null;
  };
  let pendingSearchQuery: string | null = null;
  const dispatch = (intent: CommerceIntent) => {
    if (intent.type === "variant.select") return;
    if (input.mode === "preview") {
      const body = previewCommerceBody(intent);
      if (body) void fetcher(`/dashboard/store/preview${input.previewTemplateId ? `?template=${encodeURIComponent(input.previewTemplateId)}` : ""}`, { method: "POST", body, credentials: "same-origin" }).then(refresh);
      return;
    }
    if (intent.type === "checkout.start") {
      locationAssign("/storefront/checkout");
      return;
    }
    const request = publicCommerceRequest(intent);
    if (request) void fetcher(request[0], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request[1]),
      credentials: "same-origin",
    }).then(refresh);
  };
  return {
    navigate(target) {
      const href = hrefFor(target, input.mode, input.previewTemplateId);
      if (href !== "#") locationAssign(href);
    },
    search(intent) {
      if (intent.type === "update") {
        pendingSearchQuery = String(intent.query ?? "").slice(0, 200);
        return;
      }
      if (intent.type === "clear") pendingSearchQuery = null;
      const query = intent.type === "clear"
        ? ""
        : pendingSearchQuery ?? String(intent.query ?? "").slice(0, 200);
      locationAssign(hrefFor({ routeId: "search", params: { query } }, input.mode, input.previewTemplateId));
    },
    collection(intent) {
      const url = new URL(globalThis.window?.location.href ?? "https://runtime.invalid/");
      if (intent.type === "filter") {
        if (!["category", "tag", "available", "fact-material", "fact-compatibility", "fact-ingredient", "fact-concern", "fact-heat-level"].includes(intent.facetId)) return;
        const factKind = intent.facetId.startsWith("fact-")
          ? intent.facetId.slice(5).replaceAll("-", "_")
          : null;
        const key = factKind && url.pathname === "/storefront/search"
          ? `fact.${factKind}`
          : `filter.${intent.facetId}`;
        const value = String(intent.value ?? "");
        if (value) url.searchParams.set(key, value);
        else url.searchParams.delete(key);
        url.searchParams.delete("cursor");
      }
      else if (intent.type === "sort") {
        url.searchParams.set("sort", String(intent.value ?? ""));
        url.searchParams.delete("cursor");
      }
      else if (intent.type === "page") url.searchParams.set("cursor", String(intent.cursor ?? ""));
      locationAssign(`${url.pathname}${url.search}`);
    },
    commerce: {
      mount(context) {
        const { shadowRoot, slot, authorityKey, bridge } = context;
        shadowRoot.append(trustedCommerceStyle(context, input.squareAccentCommerce === true));
        if (slot.kind === "bundleBuilder") {
          const products = (input.data?.featuredProducts ?? []).filter((product) => product.variants.some((variant) => variant.available));
          const selections = Array.from({ length: slot.slotCount ?? 0 }, () => ({ productId: "", variantId: "" }));
          const ownerDocument = shadowRoot.ownerDocument;
          const form = ownerDocument.createElement("div");
          form.setAttribute("role", "group");
          form.setAttribute("aria-label", "Build a bundle");
          const add = ownerDocument.createElement("button");
          add.type = "button";
          add.textContent = "Add bundle to cart";
          const refresh = () => { add.disabled = selections.some((selection) => !selection.variantId); };
          selections.forEach((selection, index) => {
            const productSelect = ownerDocument.createElement("select");
            productSelect.setAttribute("aria-label", `Choose product ${index + 1}`);
            productSelect.append(new Option(`Choose product ${index + 1}`, ""));
            products.forEach((product) => productSelect.append(new Option(product.title, product.id)));
            const variantSelect = ownerDocument.createElement("select");
            variantSelect.setAttribute("aria-label", `Choose option ${index + 1}`);
            variantSelect.disabled = true;
            productSelect.onchange = () => {
              selection.productId = productSelect.value;
              selection.variantId = "";
              variantSelect.replaceChildren(new Option(`Choose option ${index + 1}`, ""));
              const product = products.find((candidate) => candidate.id === productSelect.value);
              for (const variant of product?.variants.filter((candidate) => candidate.available) ?? []) {
                variantSelect.append(new Option(variant.title, variant.id));
              }
              variantSelect.disabled = !product;
              refresh();
            };
            variantSelect.onchange = () => { selection.variantId = variantSelect.value; refresh(); };
            form.append(productSelect, variantSelect);
          });
          add.onclick = () => bridge({ type: "cart.addBundle", lines: selections.map((line) => ({ ...line, quantity: 1 })) });
          refresh();
          form.append(add);
          shadowRoot.append(form);
          return;
        }
        if (slot.kind === "quickViewCommerce") {
          const productId = authorityKey.startsWith("product:") ? authorityKey.slice("product:".length) : "";
          const product = productById(productId);
          const ownerDocument = shadowRoot.ownerDocument;
          const group = ownerDocument.createElement("div");
          group.setAttribute("role", "group");
          group.setAttribute("aria-label", product ? `Buy ${product.title}` : "Product purchase options");
          const availableVariants = product?.variants.filter((variant) => variant.available) ?? [];
          const select = ownerDocument.createElement("select");
          select.setAttribute("aria-label", product ? `Choose an option for ${product.title}` : "Choose an option");
          for (const variant of availableVariants) {
            const option = ownerDocument.createElement("option");
            option.value = variant.id;
            option.textContent = variant.title;
            select.append(option);
          }
          let quickVariant: (typeof availableVariants)[number] | null = availableVariants[0] ?? null;
          select.disabled = availableVariants.length < 2;
          select.onchange = () => {
            quickVariant = availableVariants.find((variant) => variant.id === select.value) ?? null;
            if (product && quickVariant) bridge({
              type: "variant.select", productId: product.id, variantId: quickVariant.id,
            });
          };
          const button = ownerDocument.createElement("button");
          button.type = "button";
          button.textContent = quickVariant ? "Add to cart" : "Sold out";
          button.disabled = !quickVariant;
          button.onclick = () => {
            if (product && quickVariant) bridge({
              type: "cart.add", productId: product.id, variantId: quickVariant.id, quantity: 1,
            });
          };
          group.append(select, button);
          shadowRoot.append(group);
          return;
        }
        if (slot.kind === "variantPicker") {
          const select = document.createElement("select");
          select.setAttribute("aria-label", "Choose an option");
          for (const variant of input.data?.product?.variants ?? []) {
            if (!variant.available) continue;
            const option = document.createElement("option");
            option.value = variant.id;
            option.textContent = variant.title;
            select.append(option);
          }
          select.onchange = () => {
            const variant = input.data?.product?.variants.find((entry) => entry.id === select.value) ?? null;
            if (!variant || !input.data?.product) return;
            selectedVariant = variant;
            sellingPlanRefreshers.forEach((refreshPlans) => refreshPlans());
            bridge({ type: "variant.select", productId: input.data.product.id, variantId: variant.id });
          };
          shadowRoot.append(select);
          return;
        }
        if (slot.kind === "cartLineControls") {
          const lineId = authorityKey.startsWith("cartLine:") ? authorityKey.slice("cartLine:".length) : "";
          const line = input.data?.cart?.lines.find((entry) => entry.id === lineId);
          const quantity = document.createElement("input");
          quantity.type = "number";
          quantity.min = "1";
          quantity.max = "99";
          quantity.value = String(line?.quantity ?? 1);
          quantity.setAttribute("aria-label", `Quantity for ${line?.title ?? "item"}`);
          quantity.onchange = () => bridge({ type: "cart.quantity", lineId, quantity: Number(quantity.value) });
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "Remove";
          remove.onclick = () => bridge({ type: "cart.remove", lineId });
          shadowRoot.append(quantity, remove);
          return;
        }
        const button = document.createElement("button");
        button.type = "button";
        if (slot.kind === "addToCart") {
          const planSelect = document.createElement("select");
          planSelect.setAttribute("aria-label", "Purchase option");
          const refreshPlans = () => {
            planSelect.replaceChildren();
            const plans = selectedVariant?.sellingPlans ?? [];
            planSelect.hidden = plans.length === 0;
            const oneTime = document.createElement("option");
            oneTime.value = "";
            oneTime.textContent = "One-time purchase";
            planSelect.append(oneTime);
            for (const plan of plans) {
              const option = document.createElement("option");
              option.value = plan.id;
              option.textContent = `${plan.name} — ${plan.cadence}`;
              planSelect.append(option);
            }
          };
          sellingPlanRefreshers.add(refreshPlans);
          refreshPlans();
          shadowRoot.append(planSelect);
          const personalizationInputs = new Map<keyof StorefrontLinePersonalization, HTMLInputElement | HTMLTextAreaElement>();
          for (const field of slot.personalizationFields ?? []) {
            const label = document.createElement("label");
            label.textContent = field === "giftNote" ? "Gift note" : field === "giftWrap" ? "Gift wrap" : field === "recipient" ? "Recipient" : "Engraving";
            const control = field === "giftNote" ? document.createElement("textarea") : document.createElement("input");
            control.name = field;
            control.maxLength = 240;
            label.append(control);
            personalizationInputs.set(field, control);
            shadowRoot.append(label);
          }
          button.textContent = selectedVariant ? "Add to cart" : "Sold out";
          button.disabled = !selectedVariant;
          if (selectedVariant && input.data?.product) button.onclick = () => {
            const personalization = canonicalizeStorefrontLinePersonalization(Object.fromEntries(
              [...personalizationInputs].flatMap(([field, control]) => control.value ? [[field, control.value]] : []),
            ));
            bridge({
              type: "cart.add", productId: input.data!.product!.id, variantId: selectedVariant!.id, quantity: 1,
              ...(Object.keys(personalization).length === 0 ? {} : { personalization }),
              ...(planSelect.value ? { sellingPlanId: planSelect.value } : {}),
            });
          };
        } else if (slot.kind === "cartSummary" || slot.kind === "cartDrawer") {
          button.textContent = "Checkout";
          const cartId = authorityKey.startsWith("cart:") ? authorityKey.slice("cart:".length) : input.data?.cart?.id ?? "preview";
          button.onclick = () => bridge({ type: "checkout.start", cartId });
        } else {
          button.textContent = "View options";
        }
        shadowRoot.append(button);
      },
      dispatch(command) { dispatch(command.intent); },
    },
  };
}

export function placeQuickViewCommerceInCards(
  root: HTMLElement,
  artifact: Pick<RouteArtifact, "bindings" | "trustedSlots">,
): void {
  const boundTitles = [...root.querySelectorAll<HTMLElement>("[data-cd-bind-text]")];
  const slotHosts = [...root.querySelectorAll<HTMLElement>('[data-cd-trusted-slot="quickViewCommerce"]')];
  for (const slot of artifact.trustedSlots.filter((candidate) => candidate.kind === "quickViewCommerce")) {
    const hosts = slotHosts.filter((host) =>
      host.dataset.cdCompilerId === slot.id && !host.closest("article")
    );
    if (hosts.length === 0) continue;
    const cards = artifact.bindings.flatMap((binding) => {
      if (
        binding.kind !== "text" || binding.ref.kind !== "data" ||
        binding.ref.path !== "product.title" || binding.ref.scopeId === slot.scopeId
      ) return [];
      const matches = boundTitles.filter((element) => element.dataset.cdBindText === binding.id);
      const candidateCards = matches.map((element) => element.closest<HTMLElement>("article"));
      return candidateCards.length === hosts.length && candidateCards.every(Boolean)
        ? [candidateCards as HTMLElement[]]
        : [];
    })[0];
    if (!cards) continue;
    hosts.forEach((host, index) => {
      const wrapper = host.closest<HTMLElement>('[data-cd-repeat-owner="true"]');
      const card = cards[index]!;
      const target = card.querySelector<HTMLElement>(".commerce-target") ?? card;
      target.querySelectorAll(".commerce-fallback").forEach((fallback) => fallback.remove());
      target.append(host);
      if (wrapper?.childElementCount === 0) wrapper.remove();
    });
  }

  const repeatedCardContainers = [...root.querySelectorAll<HTMLElement>('[data-cd-repeat-owner="true"]')]
    .filter((owner) =>
      owner.tagName !== "ARTICLE" && owner.dataset.cdCompilerId &&
      owner.parentElement && owner.querySelector("article")
    );
  for (const owner of repeatedCardContainers) {
    if (!root.contains(owner)) continue;
    const siblings = repeatedCardContainers.filter((candidate) =>
      candidate.parentElement === owner.parentElement &&
      candidate.dataset.cdCompilerId === owner.dataset.cdCompilerId
    );
    if (siblings[0] !== owner) continue;
    for (const sibling of siblings.slice(1)) {
      owner.append(...sibling.childNodes);
      sibling.remove();
    }
  }
}

export function StorefrontHydrator(props: {
  bundle: StorefrontBundleV1;
  routeId: CompiledStorefrontRouteId;
  data: PublicPresentationData;
  mode: RuntimeMode;
}) {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-cd-bundle-runtime='1']");
    if (!root) return;
    const adapters = createRuntimeAdapters({
      mode: props.mode,
      data: props.data,
      previewTemplateId: props.mode === "preview" && props.bundle.source.kind === "recipe" ? props.bundle.source.templateId : undefined,
      squareAccentCommerce: props.bundle.source.kind === "recipe"
        && props.bundle.source.templateId === "soft-chemistry"
        && props.bundle.source.templateVersion >= 6,
    });
    const handles: StorefrontRuntimeHandle[] = [];
    const visualLayer = props.bundle.visualLayer?.kind === "fragment_shader" ? props.bundle.visualLayer : undefined;
    const shell = root.querySelector<HTMLElement>("[data-cd-bundle-shell]");
    if (shell) handles.push(hydrateStorefront({ root: shell, artifact: props.bundle.shell, adapters, visualLayer }));
    if (props.routeId !== "checkout") {
      const route = root.querySelector<HTMLElement>(`[data-cd-bundle-route='${props.routeId}']`);
      if (route) {
        const artifact = props.bundle.routes[props.routeId];
        if (!artifact) return;
        placeQuickViewCommerceInCards(route, artifact);
        handles.push(hydrateStorefront({ root: route, artifact, adapters, visualLayer }));
      }
    }
    return () => handles.forEach((handle) => handle.teardown());
  }, [props.bundle, props.data, props.mode, props.routeId]);
  return null;
}
