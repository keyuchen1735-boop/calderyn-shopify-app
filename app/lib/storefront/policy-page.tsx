import type { StorefrontPolicy } from "./policies.server";

export interface StorefrontPolicyPageProps {
  policy: StorefrontPolicy;
  store: { name: string; logo: string | null };
}

export function StorefrontPolicyPage({ policy, store }: StorefrontPolicyPageProps) {
  const paragraphs = policy.body.split(/\n{2,}/).map((value) => value.trim()).filter(Boolean);
  return (
    <div className="cd-policy-page" data-cd-storefront-policy={policy.id}>
      <header className="cd-policy-page__header">
        <a className="cd-policy-page__brand" href="/storefront">
          {store.logo ? <img src={store.logo} alt="" /> : null}
          <span>{store.name}</span>
        </a>
        <a href="/storefront">Back to store</a>
      </header>
      <main className="cd-policy-page__main">
        <p className="cd-policy-page__eyebrow">Store policy</p>
        <h1>{policy.title}</h1>
        <p className="cd-policy-page__updated">
          Updated <time dateTime={policy.updatedAt}>{policy.updatedAt.slice(0, 10)}</time>
        </p>
        <div className="cd-policy-page__body">
          {paragraphs.map((paragraph, index) => <p key={`${policy.id}-${index}`}>{paragraph}</p>)}
        </div>
      </main>
      <footer className="cd-policy-page__footer">
        <a href="/storefront">{store.name}</a>
      </footer>
    </div>
  );
}
