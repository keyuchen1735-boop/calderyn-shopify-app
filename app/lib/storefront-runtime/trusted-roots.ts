const roots = new WeakMap<HTMLElement, ShadowRoot>();

export function trustedCommerceRoot(host: HTMLElement): ShadowRoot | undefined {
  return roots.get(host);
}

export function retainTrustedCommerceRoot(host: HTMLElement, root: ShadowRoot): void {
  roots.set(host, root);
}
