import { readFileSync } from "node:fs";
import { parse, parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { describe, expect, it } from "vitest";
import { STOREFRONT_RECIPES } from ".";
import { storefrontDesignSystemCss } from "../storefront-runtime/curated-fonts";

function sourceFontFamilies(html: string): string[] {
  return [...html.matchAll(/family=([^&"']+)/g)]
    .map(([, family]) => decodeURIComponent(family!.split(":", 1)[0]!.replaceAll("+", " ")));
}

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

function elements(root: Node): Element[] {
  const found: Element[] = [];
  const visit = (node: Node) => {
    if ("tagName" in node) found.push(node);
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}

function classes(element: Element): string[] {
  return element.attrs.find(({ name }) => name === "class")?.value.split(/\s+/)
    .filter((name) => name && !["active", "open", "selected"].includes(name)) ?? [];
}

function structuralSignatures(root: Node): string[] {
  const signatures: string[] = [];
  const dynamicRegion = (element: Element) => {
    const id = element.attrs.find(({ name }) => name === "id")?.value;
    return [
      "rail", "grid", "homeGrid", "homeRail", "results", "hits", "product-grid", "momentProducts",
    ].includes(id ?? "") || classes(element).includes("formula-stack");
  };
  const name = (element: Element) => [element.tagName, ...classes(element).sort()].join(".");
  const visit = (parent: Element, insideDynamicRegion: boolean) => {
    const ignoreChildren = insideDynamicRegion || dynamicRegion(parent);
    for (const node of parent.childNodes) {
      if (!("tagName" in node)) continue;
      if (!ignoreChildren && !classes(parent).includes("all")) {
        signatures.push(`${name(parent)}>${name(node)}`);
      }
      visit(node, ignoreChildren);
    }
  };

  if ("tagName" in root) visit(root, false);
  else if ("childNodes" in root) {
    root.childNodes.forEach((node) => {
      if ("tagName" in node) visit(node, false);
    });
  }
  return signatures;
}

function approvedHomeRoots(document: Node): Element[] {
  const all = elements(document);
  const home = all.find((element) => element.attrs.some(({ name, value }) => name === "id" && value === "home"))
    ?? all.find(({ tagName }) => tagName === "main");
  const shellClass = new Set(["bar", "notice", "note", "status", "sysbar", "top"]);
  const candidates = all.filter((element) => (
    element.tagName === "header" || element.tagName === "nav" || classes(element).some((name) => shellClass.has(name))
  ));
  const candidateSet = new Set(candidates);
  const shell = candidates.filter((element) => {
    for (let parent = element.parentNode; parent && "tagName" in parent; parent = parent.parentNode) {
      if (parent === home || candidateSet.has(parent)) return false;
    }
    return true;
  });
  return shell.concat(home ? [home] : []);
}

function staticText(root: Node): string[] {
  const values: string[] = [];
  const merchantSourceCopy = new Set([
    "All devices", "Inspect MacBook Pro 14", "$1,349 →", "The live pantry / 24 provisions",
    "Solo stream / 4 modules", "$0",
  ]);
  const dynamicIds = new Set([
    "cartCount", "collectionTitle", "count", "homeGrid", "homeMatrix", "momentProducts", "product-grid", "results",
    "resultCount", "collectionGrid", "collectionMatrix", "data-ledger", "homeRail", "homeGrid",
  ]);
  const visit = (node: Node, insideDynamicRegion: boolean) => {
    if (!("childNodes" in node)) return;
    const element = "tagName" in node ? node : undefined;
    const attributes = element ? new Map(element.attrs.map(({ name, value }) => [name, value])) : new Map<string, string>();
    const dynamic = insideDynamicRegion
      || attributes.has("data-cd-repeat")
      || attributes.has("data-count")
      || attributes.has("data-total")
      || dynamicIds.has(attributes.get("id") ?? "")
      || (element ? ["productGrid", "matrix", "hits", "all", "formula-stack"].some((name) => classes(element).includes(name)) : false);
    for (const child of node.childNodes) {
      if (child.nodeName === "#text" && "value" in child && !dynamic) {
        const value = child.value.replace(/\s+/g, " ").trim();
        if (value && !merchantSourceCopy.has(value)) values.push(value);
      } else if ("childNodes" in child && !("tagName" in child && ["script", "style"].includes(child.tagName))) {
        visit(child, dynamic);
      }
    }
  };
  visit(root, false);
  return values;
}

function runtimeDocument(recipe: (typeof STOREFRONT_RECIPES)[number]): Node {
  return parseFragment(Object.values(recipe.config.surfaces)
    .map(({ source }) => source.html)
    .join(""));
}

describe("approved storefront source parity", () => {
  it("keeps each source template's exact fonts in its runtime CSS", () => {
    for (const recipe of STOREFRONT_RECIPES.filter(({ config }) => config.templateId !== "atelier-nine")) {
      const source = readFileSync(
        `docs/superpowers/prototypes/storefront-recipes/${recipe.config.templateId}.html`,
        "utf8",
      );
      const runtimeCss = storefrontDesignSystemCss(recipe.bundle.designSystem)
        + Object.values(recipe.config.surfaces)
        .map(({ source: surface }) => surface.css)
        .join("\n");

      for (const family of sourceFontFamilies(source)) {
        expect(runtimeCss, `${recipe.config.templateId}: ${family}`).toContain(family);
      }
    }
  });

  it("keeps the approved source DOM and classes outside merchant data regions", () => {
    for (const recipe of STOREFRONT_RECIPES.filter(({ config }) => config.templateId !== "atelier-nine")) {
      const approved = parse(readFileSync(
        `docs/superpowers/prototypes/storefront-recipes/${recipe.config.templateId}.html`,
        "utf8",
      ));
      const runtime = new Set(structuralSignatures(runtimeDocument(recipe)));
      const missing = approvedHomeRoots(approved)
        .flatMap(structuralSignatures)
        .filter((signature) => !runtime.has(signature));

      expect(missing, recipe.config.templateId).toEqual([]);
    }
  });

  it("keeps the approved static copy outside merchant data regions", () => {
    for (const recipe of STOREFRONT_RECIPES.filter(({ config }) => config.templateId !== "atelier-nine")) {
      const approved = parse(readFileSync(
        `docs/superpowers/prototypes/storefront-recipes/${recipe.config.templateId}.html`,
        "utf8",
      ));
      const runtime = new Set(staticText(runtimeDocument(recipe)));
      const missing = approvedHomeRoots(approved)
        .flatMap(staticText)
        .filter((value) => !runtime.has(value));

      expect(missing, recipe.config.templateId).toEqual([]);
    }
  });

  it("keeps universal source rules scoped to every recipe descendant", () => {
    const roomModes = STOREFRONT_RECIPES.find(({ config }) => config.templateId === "room-modes");
    expect(roomModes?.config.surfaces.home.source.css).toContain(".hotspot");
    expect(roomModes?.config.surfaces.home.source.css).toContain("animation:none!important");
  });
});
