import { ApiType, shopifyApiProject } from "@shopify/api-codegen-preset";
import type { IGraphQLConfig } from "graphql-config";

const documents = ["./app/**/*.{js,ts,jsx,tsx}"];

const config: IGraphQLConfig = {
  schema: "https://shopify.dev/admin-graphql-direct-proxy/2025-10",
  documents,
  projects: {
    default: shopifyApiProject({
      apiType: ApiType.Admin,
      apiVersion: "2025-10",
      documents,
      outputDir: "./app/types",
    }),
  },
};

export default config;
