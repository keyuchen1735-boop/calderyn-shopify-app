// app/lib/dashboard/discover-client.ts
import { apiGet, apiSend } from "./client";
import type { DiscoverFeedItem, PickResult } from "~/lib/sourcing/types";

export interface DiscoverState {
  items: DiscoverFeedItem[];
}

export const fetchDiscover = () => apiGet<DiscoverState>("/dashboard/api/discover");

export const pickDiscoverProduct = (sourceProductId: string) =>
  apiSend<PickResult>("POST", "/dashboard/api/discover", { action: "pick", sourceProductId });
