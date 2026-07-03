// Client fetchers for the customer-directory dashboard surface. Kept in its
// own module (not client.ts) so parallel surface work never collides on one file.
import { apiGet } from "./client";
import type {
  CustomerSegment,
  CustomerStats,
  CustomerRow,
  SegmentDef,
  CustomersPage,
  CustomerAddress,
  CustomerConsent,
  CustomerOrderRow,
  CustomerCart,
  CustomerDetail,
} from "~/lib/buyer/directory-types";

export type {
  CustomerSegment,
  CustomerStats,
  CustomerRow,
  SegmentDef,
  CustomersPage,
  CustomerAddress,
  CustomerConsent,
  CustomerOrderRow,
  CustomerCart,
  CustomerDetail,
};

export async function fetchCustomersPage(): Promise<CustomersPage> {
  return apiGet<CustomersPage>("/dashboard/api/customers");
}

export async function fetchCustomerDetail(id: string): Promise<CustomerDetail> {
  return apiGet<CustomerDetail>(`/dashboard/api/customers/${encodeURIComponent(id)}`);
}
