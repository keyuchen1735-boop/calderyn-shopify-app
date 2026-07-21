/* eslint-disable eslint-comments/disable-enable-pair */
/* eslint-disable eslint-comments/no-unlimited-disable */
/* eslint-disable */
import type * as AdminTypes from './admin.types.js';

export type CalderynShopBillingAddressQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type CalderynShopBillingAddressQuery = { shop: { billingAddress: Pick<AdminTypes.ShopAddress, 'address1' | 'address2' | 'city' | 'provinceCode' | 'zip' | 'countryCodeV2'> } };

export type LocationsQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type LocationsQuery = { locations: { nodes: Array<Pick<AdminTypes.Location, 'id' | 'name' | 'isActive'>> } };

export type ProductFactsQueryVariables = AdminTypes.Exact<{
  cursor?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type ProductFactsQuery = { products: { pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'>, nodes: Array<(
      Pick<AdminTypes.Product, 'id' | 'title'>
      & { calderynWidth?: AdminTypes.Maybe<Pick<AdminTypes.Metafield, 'id' | 'type' | 'jsonValue'>>, calderynDepth?: AdminTypes.Maybe<Pick<AdminTypes.Metafield, 'id' | 'type' | 'jsonValue'>>, calderynHeight?: AdminTypes.Maybe<Pick<AdminTypes.Metafield, 'id' | 'type' | 'jsonValue'>>, calderynMaterials?: AdminTypes.Maybe<Pick<AdminTypes.Metafield, 'id' | 'type' | 'jsonValue'>>, calderynCompatibility?: AdminTypes.Maybe<Pick<AdminTypes.Metafield, 'id' | 'type' | 'jsonValue'>>, calderynIngredients?: AdminTypes.Maybe<Pick<AdminTypes.Metafield, 'id' | 'type' | 'jsonValue'>>, calderynConcerns?: AdminTypes.Maybe<Pick<AdminTypes.Metafield, 'id' | 'type' | 'jsonValue'>>, calderynHeatLevel?: AdminTypes.Maybe<Pick<AdminTypes.Metafield, 'id' | 'type' | 'jsonValue'>>, calderynDocumentUrl?: AdminTypes.Maybe<Pick<AdminTypes.Metafield, 'id' | 'type' | 'jsonValue'>>, calderynArModelUrl?: AdminTypes.Maybe<Pick<AdminTypes.Metafield, 'id' | 'type' | 'jsonValue'>> }
    )> } };

export type ProductsQueryVariables = AdminTypes.Exact<{
  cursor?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type ProductsQuery = { products: { pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'>, nodes: Array<(
      Pick<AdminTypes.Product, 'id' | 'title' | 'status' | 'vendor' | 'productType' | 'tags'>
      & { featuredImage?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url'>>, collections: { nodes: Array<Pick<AdminTypes.Collection, 'title'>> }, variants: { nodes: Array<(
          Pick<AdminTypes.ProductVariant, 'id' | 'sku' | 'title' | 'inventoryPolicy' | 'price'>
          & { inventoryItem: (
            Pick<AdminTypes.InventoryItem, 'id' | 'tracked'>
            & { unitCost?: AdminTypes.Maybe<Pick<AdminTypes.MoneyV2, 'amount'>>, inventoryLevels: { nodes: Array<{ location: Pick<AdminTypes.Location, 'id'>, quantities: Array<Pick<AdminTypes.InventoryQuantity, 'name' | 'quantity'>> }> } }
          ) }
        )> } }
    )> } };

export type OrderDestinationsQueryVariables = AdminTypes.Exact<{
  ids: Array<AdminTypes.Scalars['ID']['input']> | AdminTypes.Scalars['ID']['input'];
}>;


export type OrderDestinationsQuery = { nodes: Array<AdminTypes.Maybe<(
    Pick<AdminTypes.Order, 'id'>
    & { shippingAddress?: AdminTypes.Maybe<Pick<AdminTypes.MailingAddress, 'city' | 'provinceCode' | 'countryCodeV2'>> }
  )>> };

export type OrdersQueryVariables = AdminTypes.Exact<{
  cursor?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
  q: AdminTypes.Scalars['String']['input'];
}>;


export type OrdersQuery = { orders: { pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'>, nodes: Array<(
      Pick<AdminTypes.Order, 'id' | 'name' | 'createdAt' | 'updatedAt' | 'displayFinancialStatus'>
      & { currentTotalPriceSet: { shopMoney: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'> }, currentSubtotalPriceSet: { shopMoney: Pick<AdminTypes.MoneyV2, 'amount'> }, totalShippingPriceSet: { shopMoney: Pick<AdminTypes.MoneyV2, 'amount'> }, currentTotalTaxSet: { shopMoney: Pick<AdminTypes.MoneyV2, 'amount'> }, currentTotalDiscountsSet: { shopMoney: Pick<AdminTypes.MoneyV2, 'amount'> }, shippingAddress?: AdminTypes.Maybe<Pick<AdminTypes.MailingAddress, 'city' | 'province' | 'provinceCode' | 'country' | 'countryCodeV2'>>, lineItems: { nodes: Array<(
          Pick<AdminTypes.LineItem, 'id' | 'quantity'>
          & { variant?: AdminTypes.Maybe<(
            Pick<AdminTypes.ProductVariant, 'id'>
            & { inventoryItem: { measurement: { weight?: AdminTypes.Maybe<Pick<AdminTypes.Weight, 'value' | 'unit'>> } } }
          )>, originalUnitPriceSet: { shopMoney: Pick<AdminTypes.MoneyV2, 'amount'> } }
        )> } }
    )> } };

export type OrderCustomerEmailsQueryVariables = AdminTypes.Exact<{
  cursor?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
  q: AdminTypes.Scalars['String']['input'];
}>;


export type OrderCustomerEmailsQuery = { orders: { pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'>, nodes: Array<(
      Pick<AdminTypes.Order, 'id'>
      & { customer?: AdminTypes.Maybe<Pick<AdminTypes.Customer, 'email'>> }
    )> } };

export type CustomersQueryVariables = AdminTypes.Exact<{
  cursor?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type CustomersQuery = { customers: { pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'>, nodes: Array<(
      Pick<AdminTypes.Customer, 'id' | 'email' | 'phone'>
      & { defaultAddress?: AdminTypes.Maybe<Pick<AdminTypes.MailingAddress, 'name' | 'address1' | 'address2' | 'city' | 'province' | 'zip' | 'country' | 'phone'>>, emailMarketingConsent?: AdminTypes.Maybe<Pick<AdminTypes.CustomerEmailMarketingConsentState, 'marketingState' | 'consentUpdatedAt'>> }
    )> } };

export type SellingPlanVariantPageQueryVariables = AdminTypes.Exact<{
  cursor?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type SellingPlanVariantPageQuery = { shop: Pick<AdminTypes.Shop, 'currencyCode'>, productVariants: { pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'>, nodes: Array<(
      Pick<AdminTypes.ProductVariant, 'id' | 'price'>
      & { sellingPlanGroups: { pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'>, nodes: Array<(
          Pick<AdminTypes.SellingPlanGroup, 'id' | 'name'>
          & { sellingPlans: { pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'>, nodes: Array<(
              Pick<AdminTypes.SellingPlan, 'id' | 'name' | 'options'>
              & { pricingPolicies: Array<(
                { __typename: 'SellingPlanFixedPricingPolicy' }
                & Pick<AdminTypes.SellingPlanFixedPricingPolicy, 'adjustmentType'>
                & { adjustmentValue: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'> | Pick<AdminTypes.SellingPlanPricingPolicyPercentageValue, 'percentage'> }
              ) | { __typename: 'SellingPlanRecurringPricingPolicy' }> }
            )> } }
        )> } }
    )> } };

export type VariantSellingPlanGroupPageQueryVariables = AdminTypes.Exact<{
  variantId: AdminTypes.Scalars['ID']['input'];
  cursor?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type VariantSellingPlanGroupPageQuery = { productVariant?: AdminTypes.Maybe<{ sellingPlanGroups: { pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'>, nodes: Array<(
        Pick<AdminTypes.SellingPlanGroup, 'id' | 'name'>
        & { sellingPlans: { pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'>, nodes: Array<(
            Pick<AdminTypes.SellingPlan, 'id' | 'name' | 'options'>
            & { pricingPolicies: Array<(
              { __typename: 'SellingPlanFixedPricingPolicy' }
              & Pick<AdminTypes.SellingPlanFixedPricingPolicy, 'adjustmentType'>
              & { adjustmentValue: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'> | Pick<AdminTypes.SellingPlanPricingPolicyPercentageValue, 'percentage'> }
            ) | { __typename: 'SellingPlanRecurringPricingPolicy' }> }
          )> } }
      )> } }> };

export type SellingPlanPageQueryVariables = AdminTypes.Exact<{
  groupId: AdminTypes.Scalars['ID']['input'];
  cursor?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type SellingPlanPageQuery = { sellingPlanGroup?: AdminTypes.Maybe<{ sellingPlans: { pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'>, nodes: Array<(
        Pick<AdminTypes.SellingPlan, 'id' | 'name' | 'options'>
        & { pricingPolicies: Array<(
          { __typename: 'SellingPlanFixedPricingPolicy' }
          & Pick<AdminTypes.SellingPlanFixedPricingPolicy, 'adjustmentType'>
          & { adjustmentValue: Pick<AdminTypes.MoneyV2, 'amount' | 'currencyCode'> | Pick<AdminTypes.SellingPlanPricingPolicyPercentageValue, 'percentage'> }
        ) | { __typename: 'SellingPlanRecurringPricingPolicy' }> }
      )> } }> };

export type CalderynCarrierServiceCreateMutationVariables = AdminTypes.Exact<{
  input: AdminTypes.DeliveryCarrierServiceCreateInput;
}>;


export type CalderynCarrierServiceCreateMutation = { carrierServiceCreate?: AdminTypes.Maybe<{ carrierService?: AdminTypes.Maybe<Pick<AdminTypes.DeliveryCarrierService, 'id' | 'name' | 'callbackUrl' | 'active' | 'supportsServiceDiscovery'>>, userErrors: Array<Pick<AdminTypes.CarrierServiceCreateUserError, 'field' | 'message'>> }> };

export type CalderynInventoryAdjustMutationVariables = AdminTypes.Exact<{
  input: AdminTypes.InventoryAdjustQuantitiesInput;
}>;


export type CalderynInventoryAdjustMutation = { inventoryAdjustQuantities?: AdminTypes.Maybe<{ inventoryAdjustmentGroup?: AdminTypes.Maybe<Pick<AdminTypes.InventoryAdjustmentGroup, 'id'>>, userErrors: Array<Pick<AdminTypes.InventoryAdjustQuantitiesUserError, 'field' | 'message' | 'code'>> }> };

export type CalderynVariantPriceQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type CalderynVariantPriceQuery = { productVariant?: AdminTypes.Maybe<(
    Pick<AdminTypes.ProductVariant, 'id' | 'price'>
    & { product: Pick<AdminTypes.Product, 'id'> }
  )> };

export type CalderynVariantPriceUpdateMutationVariables = AdminTypes.Exact<{
  productId: AdminTypes.Scalars['ID']['input'];
  variants: Array<AdminTypes.ProductVariantsBulkInput> | AdminTypes.ProductVariantsBulkInput;
}>;


export type CalderynVariantPriceUpdateMutation = { productVariantsBulkUpdate?: AdminTypes.Maybe<{ productVariants?: AdminTypes.Maybe<Array<Pick<AdminTypes.ProductVariant, 'id' | 'price'>>>, userErrors: Array<Pick<AdminTypes.ProductVariantsBulkUpdateUserError, 'field' | 'message'>> }> };

export type CalderynProductStatusMutationVariables = AdminTypes.Exact<{
  product: AdminTypes.ProductUpdateInput;
}>;


export type CalderynProductStatusMutation = { productUpdate?: AdminTypes.Maybe<{ product?: AdminTypes.Maybe<Pick<AdminTypes.Product, 'id' | 'status'>>, userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }> };

export type OnboardingShopCheckQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type OnboardingShopCheckQuery = { shop: Pick<AdminTypes.Shop, 'name' | 'myshopifyDomain'> };

interface GeneratedQueryTypes {
  "\n  query calderynShopBillingAddress {\n    shop {\n      billingAddress {\n        address1\n        address2\n        city\n        provinceCode\n        zip\n        countryCodeV2\n      }\n    }\n  }\n": {return: CalderynShopBillingAddressQuery, variables: CalderynShopBillingAddressQueryVariables},
  "#graphql\n    query Locations {\n      locations(first: 100) { nodes { id name isActive } }\n    }": {return: LocationsQuery, variables: LocationsQueryVariables},
  "#graphql\n      query ProductFacts($cursor: String) {\n        products(first: 50, after: $cursor) {\n          pageInfo { hasNextPage endCursor }\n          nodes {\n            id title\n            calderynWidth: metafield(namespace: \"custom\", key: \"calderyn_width\") { id type jsonValue }\n            calderynDepth: metafield(namespace: \"custom\", key: \"calderyn_depth\") { id type jsonValue }\n            calderynHeight: metafield(namespace: \"custom\", key: \"calderyn_height\") { id type jsonValue }\n            calderynMaterials: metafield(namespace: \"custom\", key: \"calderyn_materials\") { id type jsonValue }\n            calderynCompatibility: metafield(namespace: \"custom\", key: \"calderyn_compatibility\") { id type jsonValue }\n            calderynIngredients: metafield(namespace: \"custom\", key: \"calderyn_ingredients\") { id type jsonValue }\n            calderynConcerns: metafield(namespace: \"custom\", key: \"calderyn_concerns\") { id type jsonValue }\n            calderynHeatLevel: metafield(namespace: \"custom\", key: \"calderyn_heat_level\") { id type jsonValue }\n            calderynDocumentUrl: metafield(namespace: \"custom\", key: \"calderyn_document_url\") { id type jsonValue }\n            calderynArModelUrl: metafield(namespace: \"custom\", key: \"calderyn_ar_model_url\") { id type jsonValue }\n          }\n        }\n      }": {return: ProductFactsQuery, variables: ProductFactsQueryVariables},
  "#graphql\n      query Products($cursor: String) {\n        products(first: 25, after: $cursor) {\n          pageInfo { hasNextPage endCursor }\n          nodes {\n            id title status vendor productType tags\n            # Featured image url for the mirror->product_media promote (#13.promote):\n            # hotlinked into product_media at cutover so imported products keep their\n            # imagery. Null when the product has no image.\n            featuredImage { url }\n            # Collection membership for the inventory facet filters; first page\n            # only (a product in >20 collections is truncated — acceptable for\n            # facet slicing).\n            collections(first: 20) { nodes { title } }\n            # Slice-1 caps: page sizes kept small so the nested\n            # products×variants×inventoryLevels query stays under Shopify's\n            # 1000 single-query cost limit. variants/inventoryLevels are\n            # single-page — products with >40 variants, or variants stocked in\n            # >20 locations, are truncated; revisit if real catalogs exceed this.\n            variants(first: 40) {\n              nodes {\n                id sku title inventoryPolicy price\n                inventoryItem {\n                  id tracked\n                  unitCost { amount }\n                  inventoryLevels(first: 20) {\n                    nodes { location { id } quantities(names: [\"available\"]) { name quantity } }\n                  }\n                }\n              }\n            }\n          }\n        }\n      }": {return: ProductsQuery, variables: ProductsQueryVariables},
  "#graphql\n    query OrderDestinations($ids: [ID!]!) {\n      nodes(ids: $ids) {\n        ... on Order {\n          id\n          shippingAddress { city provinceCode countryCodeV2 }\n        }\n      }\n    }": {return: OrderDestinationsQuery, variables: OrderDestinationsQueryVariables},
  "#graphql\n      query Orders($cursor: String, $q: String!) {\n        orders(first: 50, after: $cursor, query: $q, sortKey: CREATED_AT) {\n          pageInfo { hasNextPage endCursor }\n          nodes {\n            id name createdAt updatedAt displayFinancialStatus\n            currentTotalPriceSet { shopMoney { amount currencyCode } }\n            currentSubtotalPriceSet { shopMoney { amount } }\n            totalShippingPriceSet { shopMoney { amount } }\n            currentTotalTaxSet { shopMoney { amount } }\n            currentTotalDiscountsSet { shopMoney { amount } }\n            # Retain only coarse destination geography for the shipping route\n            # read model. Street, postal, recipient, and contact fields are\n            # intentionally not requested from Shopify.\n            shippingAddress { city province provinceCode country countryCodeV2 }\n            # Slice-1 cap: single-page (orders with >100 line items truncate).\n            # Weight is NOT a field on LineItem — it lives on the variant's\n            # inventoryItem.measurement.weight. We select unit alongside value\n            # because the API returns the variant's stored unit (GRAMS,\n            # KILOGRAMS, POUNDS, or OUNCES); the mapper converts to grams.\n            lineItems(first: 100) {\n              nodes {\n                id quantity\n                variant {\n                  id\n                  inventoryItem {\n                    measurement { weight { value unit } }\n                  }\n                }\n                originalUnitPriceSet { shopMoney { amount } }\n              }\n            }\n          }\n        }\n      }": {return: OrdersQuery, variables: OrdersQueryVariables},
  "#graphql\n      query OrderCustomerEmails($cursor: String, $q: String!) {\n        orders(first: 100, after: $cursor, query: $q, sortKey: CREATED_AT) {\n          pageInfo { hasNextPage endCursor }\n          nodes { id customer { email } }\n        }\n      }": {return: OrderCustomerEmailsQuery, variables: OrderCustomerEmailsQueryVariables},
  "#graphql\n      query Customers($cursor: String) {\n        customers(first: 100, after: $cursor) {\n          pageInfo { hasNextPage endCursor }\n          nodes {\n            id email phone\n            defaultAddress { name address1 address2 city province zip country phone }\n            emailMarketingConsent { marketingState consentUpdatedAt }\n          }\n        }\n      }": {return: CustomersQuery, variables: CustomersQueryVariables},
  "#graphql\nquery SellingPlanVariantPage($cursor: String) {\n  shop { currencyCode }\n  productVariants(first: 50, after: $cursor) {\n    pageInfo { hasNextPage endCursor }\n    nodes {\n      id price\n      sellingPlanGroups(first: 100) {\n        pageInfo { hasNextPage endCursor }\n        nodes {\n          id name\n          sellingPlans(first: 100) {\n            pageInfo { hasNextPage endCursor }\n            nodes {\n              id name options\n              pricingPolicies {\n                __typename\n                ... on SellingPlanFixedPricingPolicy {\n                  adjustmentType\n                  adjustmentValue {\n                    ... on MoneyV2 { amount currencyCode }\n                    ... on SellingPlanPricingPolicyPercentageValue { percentage }\n                  }\n                }\n              }\n            }\n          }\n        }\n      }\n    }\n  }\n}": {return: SellingPlanVariantPageQuery, variables: SellingPlanVariantPageQueryVariables},
  "#graphql\nquery VariantSellingPlanGroupPage($variantId: ID!, $cursor: String) {\n  productVariant(id: $variantId) {\n    sellingPlanGroups(first: 100, after: $cursor) {\n      pageInfo { hasNextPage endCursor }\n      nodes {\n        id name\n        sellingPlans(first: 100) {\n          pageInfo { hasNextPage endCursor }\n          nodes {\n            id name options\n            pricingPolicies {\n              __typename\n              ... on SellingPlanFixedPricingPolicy {\n                adjustmentType\n                adjustmentValue {\n                  ... on MoneyV2 { amount currencyCode }\n                  ... on SellingPlanPricingPolicyPercentageValue { percentage }\n                }\n              }\n            }\n          }\n        }\n      }\n    }\n  }\n}": {return: VariantSellingPlanGroupPageQuery, variables: VariantSellingPlanGroupPageQueryVariables},
  "#graphql\nquery SellingPlanPage($groupId: ID!, $cursor: String) {\n  sellingPlanGroup(id: $groupId) {\n    sellingPlans(first: 100, after: $cursor) {\n      pageInfo { hasNextPage endCursor }\n      nodes {\n        id name options\n        pricingPolicies {\n          __typename\n          ... on SellingPlanFixedPricingPolicy {\n            adjustmentType\n            adjustmentValue {\n              ... on MoneyV2 { amount currencyCode }\n              ... on SellingPlanPricingPolicyPercentageValue { percentage }\n            }\n          }\n        }\n      }\n    }\n  }\n}": {return: SellingPlanPageQuery, variables: SellingPlanPageQueryVariables},
  "\n  query calderynVariantPrice($id: ID!) {\n    productVariant(id: $id) {\n      id\n      price\n      product {\n        id\n      }\n    }\n  }\n": {return: CalderynVariantPriceQuery, variables: CalderynVariantPriceQueryVariables},
  "#graphql\n          query OnboardingShopCheck { shop { name myshopifyDomain } }": {return: OnboardingShopCheckQuery, variables: OnboardingShopCheckQueryVariables},
}

interface GeneratedMutationTypes {
  "\n  mutation CalderynCarrierServiceCreate($input: DeliveryCarrierServiceCreateInput!) {\n    carrierServiceCreate(input: $input) {\n      carrierService {\n        id\n        name\n        callbackUrl\n        active\n        supportsServiceDiscovery\n      }\n      userErrors {\n        field\n        message\n      }\n    }\n  }\n": {return: CalderynCarrierServiceCreateMutation, variables: CalderynCarrierServiceCreateMutationVariables},
  "\n  mutation calderynInventoryAdjust($input: InventoryAdjustQuantitiesInput!) {\n    inventoryAdjustQuantities(input: $input) {\n      inventoryAdjustmentGroup {\n        id\n      }\n      userErrors {\n        field\n        message\n        code\n      }\n    }\n  }\n": {return: CalderynInventoryAdjustMutation, variables: CalderynInventoryAdjustMutationVariables},
  "\n  mutation calderynVariantPriceUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {\n    productVariantsBulkUpdate(productId: $productId, variants: $variants) {\n      productVariants {\n        id\n        price\n      }\n      userErrors {\n        field\n        message\n      }\n    }\n  }\n": {return: CalderynVariantPriceUpdateMutation, variables: CalderynVariantPriceUpdateMutationVariables},
  "\n  mutation calderynProductStatus($product: ProductUpdateInput!) {\n    productUpdate(product: $product) {\n      product {\n        id\n        status\n      }\n      userErrors {\n        field\n        message\n      }\n    }\n  }\n": {return: CalderynProductStatusMutation, variables: CalderynProductStatusMutationVariables},
}
declare module '@shopify/admin-api-client' {
  type InputMaybe<T> = AdminTypes.InputMaybe<T>;
  interface AdminQueries extends GeneratedQueryTypes {}
  interface AdminMutations extends GeneratedMutationTypes {}
}
