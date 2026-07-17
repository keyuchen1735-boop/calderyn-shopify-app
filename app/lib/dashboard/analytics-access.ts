import { isPaired } from "../integrations";

type IntegrationStatus = "connected" | "pending" | "disconnected" | "reauth";

export function canViewOperatingPnl(
  integrations: Array<{ key: string; status: IntegrationStatus }>,
): boolean {
  const quickbooks = integrations.find((integration) => integration.key === "quickbooks");
  return quickbooks ? isPaired(quickbooks.status) : false;
}
