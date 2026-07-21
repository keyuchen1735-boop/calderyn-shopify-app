import { unauthenticated } from "../../shopify.server";
import { replaceSellingPlanSnapshot, type SellingPlanSnapshot } from "~/lib/storefront/selling-plan-sync.server";

export const SHOPIFY_SELLING_PLAN_QUERY = `#graphql
query SellingPlanVariantPage($cursor: String) {
  shop { currencyCode }
  productVariants(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id price
      sellingPlanGroups(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id name
          sellingPlans(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id name options
              pricingPolicies {
                __typename
                ... on SellingPlanFixedPricingPolicy {
                  adjustmentType
                  adjustmentValue {
                    ... on MoneyV2 { amount currencyCode }
                    ... on SellingPlanPricingPolicyPercentageValue { percentage }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

export const SHOPIFY_VARIANT_SELLING_PLAN_GROUP_PAGE_QUERY = `#graphql
query VariantSellingPlanGroupPage($variantId: ID!, $cursor: String) {
  productVariant(id: $variantId) {
    sellingPlanGroups(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name
        sellingPlans(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id name options
            pricingPolicies {
              __typename
              ... on SellingPlanFixedPricingPolicy {
                adjustmentType
                adjustmentValue {
                  ... on MoneyV2 { amount currencyCode }
                  ... on SellingPlanPricingPolicyPercentageValue { percentage }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

export const SHOPIFY_SELLING_PLAN_PAGE_QUERY = `#graphql
query SellingPlanPage($groupId: ID!, $cursor: String) {
  sellingPlanGroup(id: $groupId) {
    sellingPlans(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name options
        pricingPolicies {
          __typename
          ... on SellingPlanFixedPricingPolicy {
            adjustmentType
            adjustmentValue {
              ... on MoneyV2 { amount currencyCode }
              ... on SellingPlanPricingPolicyPercentageValue { percentage }
            }
          }
        }
      }
    }
  }
}`;

type PricePolicy = {
  __typename?: string;
  adjustmentType?: "PRICE" | "FIXED_AMOUNT" | "PERCENTAGE";
  adjustmentValue?: { amount?: string; currencyCode?: string; percentage?: number };
};
type SellingPlanNode = { id: string; name: string; options: string[]; pricingPolicies: PricePolicy[] };
type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] };
type SellingPlanGroupNode = { id: string; name: string; sellingPlans: Page<SellingPlanNode> };
type VariantNode = { id: string; price: string; sellingPlanGroups: Page<SellingPlanGroupNode> };
type VariantPage = {
  shop: { currencyCode: string };
  productVariants: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: VariantNode[];
  };
};
type GroupPage = { productVariant: { sellingPlanGroups: Page<SellingPlanGroupNode> } | null };
type PlanPage = { sellingPlanGroup: { sellingPlans: Page<SellingPlanNode> } | null };

function cents(amount: string): number {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid Shopify money amount ${JSON.stringify(amount)}`);
  return Math.round(value * 100);
}

function adjustedPrice(variantPrice: string, currency: string, policies: PricePolicy[]) {
  const policy = policies.length === 1 && policies[0].__typename === "SellingPlanFixedPricingPolicy"
    ? policies[0]
    : undefined;
  if (!policy?.adjustmentType || !policy.adjustmentValue) return {};
  const base = cents(variantPrice);
  if (policy.adjustmentType === "PERCENTAGE" && typeof policy.adjustmentValue.percentage === "number") {
    return { priceCents: Math.max(0, Math.round(base * (100 - policy.adjustmentValue.percentage) / 100)), currency };
  }
  if (typeof policy.adjustmentValue.amount !== "string") return {};
  const adjustment = cents(policy.adjustmentValue.amount);
  const adjustmentCurrency = policy.adjustmentValue.currencyCode ?? currency;
  return policy.adjustmentType === "PRICE"
    ? { priceCents: adjustment, currency: adjustmentCurrency }
    : policy.adjustmentType === "FIXED_AMOUNT"
      ? { priceCents: Math.max(0, base - adjustment), currency: adjustmentCurrency }
      : {};
}

export async function fetchShopifySellingPlanSnapshot(shopDomain: string): Promise<SellingPlanSnapshot> {
  const { admin } = await unauthenticated.admin(shopDomain);
  const groups = new Map<string, SellingPlanSnapshot["groups"][number]>();
  const plans = new Map<string, SellingPlanSnapshot["plans"][number]>();
  const eligibility = new Map<string, SellingPlanSnapshot["eligibility"][number]>();
  const variantCursors = new Set<string>();
  let cursor: string | null = null;
  async function request<T>(query: string, variables: Record<string, string | null>): Promise<T> {
    const response = await admin.graphql(query, { variables });
    const body = await response.json() as { data?: T; errors?: unknown };
    if (body.errors) throw new Error(`Admin GraphQL error: ${JSON.stringify(body.errors)}`);
    if (!body.data) throw new Error("Admin GraphQL returned no selling-plan data");
    return body.data;
  }
  async function ingestPlanPage(
    variant: VariantNode,
    group: SellingPlanGroupNode,
    currency: string,
    firstPage: Page<SellingPlanNode>,
  ): Promise<void> {
    let page = firstPage;
    const seenCursors = new Set<string>();
    for (;;) {
      for (const plan of page.nodes) {
        const cadence = plan.options.map((option) => option.trim()).filter(Boolean).join(" · ");
        if (!cadence) throw new Error(`Selling plan ${plan.id} has no source cadence option`);
        plans.set(plan.id, { externalId: plan.id, groupExternalId: group.id, name: plan.name, cadence });
        eligibility.set(`${variant.id}\0${plan.id}`, {
          variantExternalId: variant.id, planExternalId: plan.id,
          ...adjustedPrice(variant.price, currency, plan.pricingPolicies),
        });
      }
      if (!page.pageInfo.hasNextPage) return;
      const planCursor = page.pageInfo.endCursor;
      if (!planCursor || seenCursors.has(planCursor)) throw new Error(`Shopify selling-plan pagination made no progress for ${group.id}`);
      seenCursors.add(planCursor);
      const data = await request<PlanPage>(SHOPIFY_SELLING_PLAN_PAGE_QUERY, { groupId: group.id, cursor: planCursor });
      if (!data.sellingPlanGroup) throw new Error(`Shopify selling-plan group ${group.id} disappeared during pagination`);
      page = data.sellingPlanGroup.sellingPlans;
    }
  }
  async function ingestGroupPages(variant: VariantNode, currency: string): Promise<void> {
    let page = variant.sellingPlanGroups;
    const seenCursors = new Set<string>();
    for (;;) {
      for (const group of page.nodes) {
        groups.set(group.id, { externalId: group.id, name: group.name });
        await ingestPlanPage(variant, group, currency, group.sellingPlans);
      }
      if (!page.pageInfo.hasNextPage) return;
      const groupCursor = page.pageInfo.endCursor;
      if (!groupCursor || seenCursors.has(groupCursor)) throw new Error(`Shopify selling-plan group pagination made no progress for ${variant.id}`);
      seenCursors.add(groupCursor);
      const data = await request<GroupPage>(SHOPIFY_VARIANT_SELLING_PLAN_GROUP_PAGE_QUERY, {
        variantId: variant.id, cursor: groupCursor,
      });
      if (!data.productVariant) throw new Error(`Shopify variant ${variant.id} disappeared during selling-plan pagination`);
      page = data.productVariant.sellingPlanGroups;
    }
  }
  do {
    const data: VariantPage = await request<VariantPage>(SHOPIFY_SELLING_PLAN_QUERY, { cursor });
    const currency = data.shop.currencyCode;
    for (const variant of data.productVariants.nodes) await ingestGroupPages(variant, currency);
    cursor = data.productVariants.pageInfo.hasNextPage
      ? data.productVariants.pageInfo.endCursor
      : null;
    if (data.productVariants.pageInfo.hasNextPage && (!cursor || variantCursors.has(cursor))) {
      throw new Error("Shopify selling-plan pagination made no progress");
    }
    if (cursor) variantCursors.add(cursor);
  } while (cursor);
  return { groups: [...groups.values()], plans: [...plans.values()], eligibility: [...eligibility.values()] };
}

export async function syncShopifySellingPlans(shopDomain: string, shopId: string) {
  return replaceSellingPlanSnapshot(shopId, "shopify", await fetchShopifySellingPlanSnapshot(shopDomain));
}
