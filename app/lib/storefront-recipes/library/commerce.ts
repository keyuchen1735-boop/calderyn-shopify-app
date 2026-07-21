import { recipeAttribute, recipeText, type RecipeFragment } from "./fragment";

export function proofBandFragment(options: { className: string; copy: string }): RecipeFragment {
  return { html: `<aside class="${recipeAttribute(options.className)}">${recipeText(options.copy)}</aside>`, css: "" };
}

export function productRailFragment(options: { className: string; itemClassName: string }): RecipeFragment {
  return {
    html: `<section class="${recipeAttribute(options.className)}"><article class="${recipeAttribute(options.itemClassName)}" data-cd-repeat="featured.products" data-cd-key="product.id"><span data-cd-text="product.title"></span></article></section>`,
    css: "",
  };
}

export function stickyPurchaseFragment(options: { desktopClassName: string; mobileClassName: string }): RecipeFragment {
  return {
    html: `<div class="${recipeAttribute(options.desktopClassName)}" data-cd-slot="addToCart"></div><div class="${recipeAttribute(options.mobileClassName)}" data-cd-slot="addToCart"></div>`,
    css: "",
  };
}

export function cartProgressFragment(options: { className: string; copy: string; orderBumpCopy?: string }): RecipeFragment {
  const orderBump = options.orderBumpCopy ? `<span>${recipeText(options.orderBumpCopy)}</span>` : "";
  return { html: `<div class="${recipeAttribute(options.className)}"><span>${recipeText(options.copy)}</span><span data-cd-money="cart.subtotal"></span>${orderBump}</div>`, css: "" };
}
