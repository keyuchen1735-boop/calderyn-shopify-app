// The test transaction's return-leg contract. startTestTransaction (server) builds the
// Stripe return URLs from these; the Cutover screen (client) consumes them. One module —
// importable from both sides — so producer and consumer cannot drift apart silently.
export const GOLIVE_PATH = "/dashboard/settings/golive";
export const TEST_TX_PARAM = "test_tx";
export const TEST_TX_SUCCESS = "success";
export const TEST_TX_CANCELLED = "cancelled";
