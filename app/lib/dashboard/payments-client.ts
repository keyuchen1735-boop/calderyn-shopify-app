// Client fetchers for the payments dashboard surface. Kept in its own module
// (not client.ts) so parallel surface work never collides on one file.
import { apiGet } from "./client";
import type {
  LedgerRow,
  PaymentsPage,
  PaymentsSummary,
  PendingIntentRow,
} from "~/lib/payments/summary-types";

export type { LedgerRow, PaymentsPage, PaymentsSummary, PendingIntentRow };

export async function fetchPaymentsPage(): Promise<PaymentsPage> {
  return apiGet<PaymentsPage>("/dashboard/api/payments");
}
