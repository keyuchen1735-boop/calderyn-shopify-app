import { useMemo, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

import type {
  AbandonedCheckoutRow,
  DraftCartRow,
  OrdersPage,
  ShipChargeRow,
} from "~/lib/dashboard/orders-client";
import { money, timeAgo } from "../format";
import { reduced } from "../hero/hero-motion";
import { Btn, Card } from "../ui";
import {
  OrderBulkBar,
  OrderListPagination,
  OrderListTable,
  OrderListToolbar,
  OrderSortHeader,
  nextSortState,
  type OrderListView,
} from "./OrderListFamily";

export type OrderSubSection = "labels" | "drafts" | "abandoned";

interface SubListState {
  view: string;
  search: string;
  sort: string;
  dir: "asc" | "desc";
  filterOne: string;
  filterTwo: string;
  offset: number;
}

const PAGE_SIZE = 25;

const INITIAL_STATE: Record<OrderSubSection, SubListState> = {
  labels: {
    view: "all",
    search: "",
    sort: "date",
    dir: "desc",
    filterOne: "",
    filterTwo: "",
    offset: 0,
  },
  drafts: {
    view: "all",
    search: "",
    sort: "date",
    dir: "desc",
    filterOne: "",
    filterTwo: "",
    offset: 0,
  },
  abandoned: {
    view: "all",
    search: "",
    sort: "date",
    dir: "desc",
    filterOne: "",
    filterTwo: "",
    offset: 0,
  },
};

const VIEWS: Record<OrderSubSection, OrderListView[]> = {
  labels: [
    { id: "all", label: "All charges" },
    { id: "unmatched", label: "Unmatched" },
    { id: "matched", label: "Matched" },
  ],
  drafts: [
    { id: "all", label: "All carts" },
    { id: "identified", label: "Identified" },
    { id: "guest", label: "Guest" },
  ],
  abandoned: [
    { id: "all", label: "All checkouts" },
    { id: "unsent", label: "Needs email" },
    { id: "sent", label: "Contacted" },
  ],
};

// Every sub-list defaults to newest-first; nextSortState cycles a header back here on its third
// click, which is also the only way back to date order on the labels list (it has no date column).
const SUB_LIST_DEFAULT_SORT = { sort: "date", dir: "desc" } as const;

const LABELS_COLUMNS =
  "36px 108px minmax(132px,1fr) minmax(190px,1.5fr) 96px 104px";
const DRAFTS_COLUMNS = "36px 112px minmax(210px,1.6fr) 86px 104px 106px";
const ABANDONED_COLUMNS =
  "36px 112px minmax(190px,1.5fr) 96px 134px 100px 166px";

type ChargeListRow = ShipChargeRow & { key: string };
type DraftListRow = DraftCartRow & { key: string };
type AbandonedListRow = AbandonedCheckoutRow & { key: string };

function compareText(a: string | null, b: string | null): number {
  return (a ?? "").localeCompare(b ?? "", undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function csvCell(value: string | number | null): string {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCsv(
  filename: string,
  rows: Array<Array<string | number | null>>,
): void {
  const body = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const url = URL.createObjectURL(
    new Blob([body], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function chargeKey(row: ShipChargeRow, index: number): string {
  return `${row.createdAt}:${row.orderRef}:${row.tracking ?? ""}:${row.costCents}:${index}`;
}

function selectOptions(values: string[], allLabel: string) {
  return [
    <option key="" value="">
      {allLabel}
    </option>,
    ...values.map((value) => (
      <option key={value} value={value}>
        {value}
      </option>
    )),
  ];
}

export default function OrderSubLists({
  section,
  page,
  loading,
  error,
  recoverySending,
  onSendRecovery,
}: {
  section: OrderSubSection;
  page: OrdersPage | null;
  loading: boolean;
  error: string | null;
  recoverySending: Set<string>;
  onSendRecovery: (orderId: string) => Promise<void>;
}) {
  const [states, setStates] = useState(INITIAL_STATE);
  const [selected, setSelected] = useState<
    Record<OrderSubSection, Set<string>>
  >(() => ({
    labels: new Set(),
    drafts: new Set(),
    abandoned: new Set(),
  }));
  const state = states[section];

  const updateState = (patch: Partial<SubListState>) => {
    setStates((current) => ({
      ...current,
      [section]: { ...current[section], ...patch, offset: patch.offset ?? 0 },
    }));
    if (patch.offset === undefined) {
      setSelected((current) => ({ ...current, [section]: new Set() }));
    }
  };

  // Header-driven sorting via the shared nextSortState policy (OrderListFamily.tsx).
  const sortBy = (col: string) => {
    updateState(
      nextSortState(
        { sort: state.sort, dir: state.dir },
        col,
        SUB_LIST_DEFAULT_SORT,
      ),
    );
  };

  const sortHd = (label: string, col: string, align?: "right") => (
    <OrderSortHeader
      label={label}
      col={col}
      sort={state.sort}
      dir={state.dir}
      onSort={sortBy}
      align={align}
    />
  );

  const carriers = useMemo(
    () =>
      Array.from(
        new Set(
          (page?.shipCharges ?? [])
            .map((row) => row.carrier)
            .filter((value): value is string => !!value),
        ),
      ).sort(),
    [page],
  );

  const chargeRows = useMemo<ChargeListRow[]>(() => {
    const query = state.search.trim().toLowerCase();
    const rows = (page?.shipCharges ?? [])
      .map((row, index) => ({ ...row, key: chargeKey(row, index) }))
      .filter((row) => {
        if (state.view === "matched" && !row.matched) return false;
        if (state.view === "unmatched" && row.matched) return false;
        if (state.filterOne && row.carrier !== state.filterOne) return false;
        if (state.filterTwo === "matched" && !row.matched) return false;
        if (state.filterTwo === "unmatched" && row.matched) return false;
        if (!query) return true;
        return `${row.orderRef} ${row.carrier ?? ""} ${row.tracking ?? ""}`
          .toLowerCase()
          .includes(query);
      });
    const direction = state.dir === "asc" ? 1 : -1;
    return rows.sort((a, b) => {
      if (state.sort === "cost") return (a.costCents - b.costCents) * direction;
      if (state.sort === "order")
        return compareText(a.orderRef, b.orderRef) * direction;
      return (
        (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) *
        direction
      );
    });
  }, [page, state]);

  const draftRows = useMemo<DraftListRow[]>(() => {
    const query = state.search.trim().toLowerCase();
    const rows = (page?.drafts ?? [])
      .map((row) => ({ ...row, key: row.id }))
      .filter((row) => {
        if (state.view === "identified" && !row.buyerEmail) return false;
        if (state.view === "guest" && row.buyerEmail) return false;
        if (state.filterOne === "identified" && !row.buyerEmail) return false;
        if (state.filterOne === "guest" && row.buyerEmail) return false;
        if (state.filterTwo === "one" && row.itemCount !== 1) return false;
        if (state.filterTwo === "multiple" && row.itemCount < 2) return false;
        if (!query) return true;
        return `${row.ref} ${row.buyerEmail ?? "guest"}`
          .toLowerCase()
          .includes(query);
      });
    const direction = state.dir === "asc" ? 1 : -1;
    return rows.sort((a, b) => {
      if (state.sort === "value")
        return (a.valueCents - b.valueCents) * direction;
      if (state.sort === "customer")
        return compareText(a.buyerEmail, b.buyerEmail) * direction;
      return (
        (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) *
        direction
      );
    });
  }, [page, state]);

  const abandonedRows = useMemo<AbandonedListRow[]>(() => {
    const query = state.search.trim().toLowerCase();
    const rows = (page?.abandoned ?? [])
      .map((row) => ({ ...row, key: row.id }))
      .filter((row) => {
        if (state.view === "sent" && !row.recoveryEmailSentAt) return false;
        if (state.view === "unsent" && row.recoveryEmailSentAt) return false;
        if (state.filterOne === "identified" && !row.buyerEmail) return false;
        if (state.filterOne === "guest" && row.buyerEmail) return false;
        if (state.filterTwo === "sent" && !row.recoveryEmailSentAt)
          return false;
        if (state.filterTwo === "unsent" && row.recoveryEmailSentAt)
          return false;
        if (!query) return true;
        return `${row.ref} ${row.buyerEmail ?? "guest"}`
          .toLowerCase()
          .includes(query);
      });
    const direction = state.dir === "asc" ? 1 : -1;
    return rows.sort((a, b) => {
      if (state.sort === "value")
        return (a.totalCents - b.totalCents) * direction;
      if (state.sort === "customer")
        return compareText(a.buyerEmail, b.buyerEmail) * direction;
      return (
        (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) *
        direction
      );
    });
  }, [page, state]);

  const allRows =
    section === "labels"
      ? chargeRows
      : section === "drafts"
        ? draftRows
        : abandonedRows;
  const visibleRows = allRows.slice(state.offset, state.offset + PAGE_SIZE);
  const selectedKeys = selected[section];
  const visibleKeys = visibleRows.map((row) => row.key);
  const allVisibleSelected =
    visibleKeys.length > 0 && visibleKeys.every((key) => selectedKeys.has(key));
  const isFiltered =
    state.view !== "all" ||
    !!state.search.trim() ||
    !!state.filterOne ||
    !!state.filterTwo;

  const toggleRow = (key: string) => {
    setSelected((current) => {
      const next = new Set(current[section]);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...current, [section]: next };
    });
  };

  const toggleAll = () => {
    setSelected((current) => {
      const next = new Set(current[section]);
      if (allVisibleSelected) visibleKeys.forEach((key) => next.delete(key));
      else visibleKeys.forEach((key) => next.add(key));
      return { ...current, [section]: next };
    });
  };

  const clearSelection = () =>
    setSelected((current) => ({ ...current, [section]: new Set() }));

  const exportRows = (selectedOnly = false) => {
    if (section === "labels") {
      const rows = chargeRows.filter(
        (row) => !selectedOnly || selectedKeys.has(row.key),
      );
      downloadCsv("shipping-charges.csv", [
        ["Order", "Carrier", "Tracking", "Cost", "Status", "Recorded"],
        ...rows.map((row) => [
          row.orderRef,
          row.carrier,
          row.tracking,
          (row.costCents / 100).toFixed(2),
          row.matched ? "Matched" : "Unmatched",
          row.createdAt,
        ]),
      ]);
      return;
    }
    if (section === "drafts") {
      const rows = draftRows.filter(
        (row) => !selectedOnly || selectedKeys.has(row.key),
      );
      downloadCsv("draft-carts.csv", [
        ["Cart", "Customer", "Items", "Value", "Started"],
        ...rows.map((row) => [
          row.ref,
          row.buyerEmail ?? "Guest",
          row.itemCount,
          (row.valueCents / 100).toFixed(2),
          row.createdAt,
        ]),
      ]);
      return;
    }
    const rows = abandonedRows.filter(
      (row) => !selectedOnly || selectedKeys.has(row.key),
    );
    downloadCsv("abandoned-checkouts.csv", [
      ["Checkout", "Customer", "Value", "Recovery", "Started"],
      ...rows.map((row) => [
        row.ref,
        row.buyerEmail ?? "Guest",
        (row.totalCents / 100).toFixed(2),
        row.recoveryEmailSentAt ?? "Not sent",
        row.createdAt,
      ]),
    ]);
  };

  const sendSelectedRecovery = async () => {
    const ids = abandonedRows
      .filter(
        (row) =>
          selectedKeys.has(row.key) &&
          !row.recoveryEmailSentAt &&
          !recoverySending.has(row.id),
      )
      .map((row) => row.id);
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `Send recovery email to ${ids.length} selected ${ids.length === 1 ? "checkout" : "checkouts"}?`,
      )
    )
      return;
    await Promise.all(ids.map((id) => onSendRecovery(id)));
  };

  const listRef = useRef<HTMLDivElement>(null);
  const visibleKey = `${section}:${loading}:${error ?? ""}:${isFiltered}:${visibleRows
    .map((row) =>
      "recoveryEmailSentAt" in row
        ? `${row.key}:${row.recoveryEmailSentAt ?? "unsent"}`
        : row.key,
    )
    .join("|")}`;
  useGSAP(
    () => {
      if (reduced() || !listRef.current) return;
      const targets = listRef.current.querySelectorAll<HTMLElement>(
        ".cd-trow, .cd-orders-state",
      );
      gsap.from(targets, {
        autoAlpha: 0,
        y: 5,
        duration: 0.24,
        stagger: 0.025,
        ease: "power2.out",
        clearProps: "opacity,visibility,transform",
      });
    },
    { dependencies: [visibleKey], scope: listRef, revertOnUpdate: true },
  );

  const activeFilterCount =
    (state.filterOne ? 1 : 0) + (state.filterTwo ? 1 : 0);
  const label =
    section === "labels"
      ? "Shipping charge"
      : section === "drafts"
        ? "Draft cart"
        : "Abandoned checkout";

  const filterChildren =
    section === "labels" ? (
      <div className="cd-orders-filter-fields">
        <select
          className="cd-input"
          aria-label="Carrier"
          value={state.filterOne}
          onChange={(event) => updateState({ filterOne: event.target.value })}
        >
          {selectOptions(carriers, "All carriers")}
        </select>
        <select
          className="cd-input"
          aria-label="Match status"
          value={state.filterTwo}
          onChange={(event) => updateState({ filterTwo: event.target.value })}
        >
          <option value="">Any status</option>
          <option value="matched">Matched</option>
          <option value="unmatched">Unmatched</option>
        </select>
      </div>
    ) : section === "drafts" ? (
      <div className="cd-orders-filter-fields">
        <select
          className="cd-input"
          aria-label="Customer type"
          value={state.filterOne}
          onChange={(event) => updateState({ filterOne: event.target.value })}
        >
          <option value="">Any customer</option>
          <option value="identified">Identified</option>
          <option value="guest">Guest</option>
        </select>
        <select
          className="cd-input"
          aria-label="Cart size"
          value={state.filterTwo}
          onChange={(event) => updateState({ filterTwo: event.target.value })}
        >
          <option value="">Any cart size</option>
          <option value="one">1 item</option>
          <option value="multiple">2+ items</option>
        </select>
      </div>
    ) : (
      <div className="cd-orders-filter-fields">
        <select
          className="cd-input"
          aria-label="Customer type"
          value={state.filterOne}
          onChange={(event) => updateState({ filterOne: event.target.value })}
        >
          <option value="">Any customer</option>
          <option value="identified">Identified</option>
          <option value="guest">Guest</option>
        </select>
        <select
          className="cd-input"
          aria-label="Recovery status"
          value={state.filterTwo}
          onChange={(event) => updateState({ filterTwo: event.target.value })}
        >
          <option value="">Any recovery status</option>
          <option value="unsent">Needs email</option>
          <option value="sent">Contacted</option>
        </select>
      </div>
    );

  return (
    <Card pad={false} className="cd-order-workspace">
      <OrderListToolbar
        views={VIEWS[section]}
        view={state.view}
        onViewChange={(view) => updateState({ view })}
        searchValue={state.search}
        searchPlaceholder={
          section === "labels"
            ? "Search charges"
            : section === "drafts"
              ? "Search carts"
              : "Search checkouts"
        }
        searchAriaLabel={`Search ${label.toLowerCase()}s`}
        onSearchChange={(search) => updateState({ search })}
        activeFilterCount={activeFilterCount}
        filterLabel={label}
        filterChildren={filterChildren}
        onExport={() => exportRows(false)}
      />

      <OrderBulkBar count={selectedKeys.size}>
        {section === "abandoned" && (
          <Btn
            small
            icon="mail"
            disabled={
              !abandonedRows.some(
                (row) =>
                  selectedKeys.has(row.key) &&
                  !row.recoveryEmailSentAt &&
                  !recoverySending.has(row.id),
              )
            }
            onClick={() => void sendSelectedRecovery()}
          >
            Send recovery
          </Btn>
        )}
        <Btn small icon="download" onClick={() => exportRows(true)}>
          Export selected
        </Btn>
        <Btn small onClick={clearSelection}>
          Clear
        </Btn>
      </OrderBulkBar>

      <div ref={listRef}>
        {section === "labels" ? (
          <OrderListTable
            loading={loading}
            error={error}
            empty={visibleRows.length === 0}
            filtered={isFiltered}
            minWidth={760}
            columns={LABELS_COLUMNS}
            emptyIcon="truck"
            emptyTitle="No shipping charges yet"
            filteredTitle="No charges match this view"
            headers={
              <>
                <span>
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    aria-label="Select all shipping charges on this page"
                  />
                </span>
                {sortHd("Order", "order")}
                <span>Carrier</span>
                <span>Tracking</span>
                {sortHd("Cost", "cost", "right")}
                <span>Status</span>
              </>
            }
          >
            {(visibleRows as ChargeListRow[]).map((row) => (
              <div
                key={row.key}
                className="cd-trow cd-order-family-row"
                data-selected={selectedKeys.has(row.key) ? "1" : "0"}
                data-attention={row.matched ? "0" : "1"}
                style={{ gridTemplateColumns: LABELS_COLUMNS }}
              >
                <input
                  type="checkbox"
                  checked={selectedKeys.has(row.key)}
                  onChange={() => toggleRow(row.key)}
                  aria-label={`Select shipping charge ${row.orderRef}`}
                />
                <div className="cd-row-title tabular-nums">{row.orderRef}</div>
                <div className="truncate">{row.carrier ?? "—"}</div>
                <div className="cd-caption tabular-nums truncate">
                  {row.tracking ?? "—"}
                </div>
                <div className="cd-row-num tabular-nums text-right">
                  {money(row.costCents)}
                </div>
                <div>
                  <span
                    className={`cd-badge${row.matched ? "" : " cd-order-badge-live"}`}
                  >
                    {row.matched ? "Matched" : "Unmatched"}
                  </span>
                </div>
              </div>
            ))}
          </OrderListTable>
        ) : section === "drafts" ? (
          <OrderListTable
            loading={loading}
            error={error}
            empty={visibleRows.length === 0}
            filtered={isFiltered}
            minWidth={760}
            columns={DRAFTS_COLUMNS}
            emptyIcon="doc"
            emptyTitle="No open carts"
            filteredTitle="No carts match this view"
            headers={
              <>
                <span>
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    aria-label="Select all draft carts on this page"
                  />
                </span>
                <span>Cart</span>
                {sortHd("Customer", "customer")}
                <span>Items</span>
                {sortHd("Value", "value", "right")}
                {sortHd("Started", "date")}
              </>
            }
          >
            {(visibleRows as DraftListRow[]).map((row) => (
              <div
                key={row.key}
                className="cd-trow cd-order-family-row"
                data-selected={selectedKeys.has(row.key) ? "1" : "0"}
                style={{ gridTemplateColumns: DRAFTS_COLUMNS }}
              >
                <input
                  type="checkbox"
                  checked={selectedKeys.has(row.key)}
                  onChange={() => toggleRow(row.key)}
                  aria-label={`Select draft cart ${row.ref}`}
                />
                <div className="cd-row-title tabular-nums">{row.ref}</div>
                <div className="truncate">{row.buyerEmail ?? "Guest"}</div>
                <div className="cd-caption tabular-nums">
                  {row.itemCount} {row.itemCount === 1 ? "item" : "items"}
                </div>
                <div className="cd-row-num tabular-nums text-right">
                  {money(row.valueCents, row.currency)}
                </div>
                <div className="cd-caption">{timeAgo(row.createdAt)}</div>
              </div>
            ))}
          </OrderListTable>
        ) : (
          <OrderListTable
            loading={loading}
            error={error}
            empty={visibleRows.length === 0}
            filtered={isFiltered}
            minWidth={900}
            columns={ABANDONED_COLUMNS}
            emptyIcon="clock"
            emptyTitle="No abandoned checkouts"
            filteredTitle="No checkouts match this view"
            headers={
              <>
                <span>
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    aria-label="Select all abandoned checkouts on this page"
                  />
                </span>
                <span>Checkout</span>
                {sortHd("Customer", "customer")}
                {sortHd("Value", "value", "right")}
                <span>Recovery</span>
                {sortHd("Started", "date")}
                <span />
              </>
            }
          >
            {(visibleRows as AbandonedListRow[]).map((row) => (
              <div
                key={row.key}
                className="cd-trow cd-order-family-row"
                data-selected={selectedKeys.has(row.key) ? "1" : "0"}
                data-attention={row.recoveryEmailSentAt ? "0" : "1"}
                style={{ gridTemplateColumns: ABANDONED_COLUMNS }}
              >
                <input
                  type="checkbox"
                  checked={selectedKeys.has(row.key)}
                  onChange={() => toggleRow(row.key)}
                  aria-label={`Select abandoned checkout ${row.ref}`}
                />
                <div className="cd-row-title tabular-nums">{row.ref}</div>
                <div className="truncate">{row.buyerEmail ?? "Guest"}</div>
                <div className="cd-row-num tabular-nums text-right">
                  {money(row.totalCents, row.currency)}
                </div>
                <div>
                  <span
                    className={`cd-badge${row.recoveryEmailSentAt ? "" : " cd-order-badge-live"}`}
                  >
                    {row.recoveryEmailSentAt
                      ? `Sent ${timeAgo(row.recoveryEmailSentAt)}`
                      : "Needs email"}
                  </span>
                </div>
                <div className="cd-caption">{timeAgo(row.createdAt)}</div>
                <div className="cd-order-row-actions">
                  <Btn
                    small
                    icon="mail"
                    disabled={recoverySending.has(row.id)}
                    onClick={() => void onSendRecovery(row.id)}
                  >
                    {recoverySending.has(row.id)
                      ? "Sending…"
                      : row.recoveryEmailSentAt
                        ? "Resend"
                        : "Send email"}
                  </Btn>
                </div>
              </div>
            ))}
          </OrderListTable>
        )}
      </div>

      {allRows.length > 0 && (
        <OrderListPagination
          start={state.offset + 1}
          end={Math.min(state.offset + visibleRows.length, allRows.length)}
          total={allRows.length}
          onPrevious={() =>
            updateState({ offset: Math.max(0, state.offset - PAGE_SIZE) })
          }
          onNext={() => updateState({ offset: state.offset + PAGE_SIZE })}
        />
      )}
    </Card>
  );
}
