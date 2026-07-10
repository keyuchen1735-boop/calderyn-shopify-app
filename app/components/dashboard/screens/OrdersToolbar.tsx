import { useState } from "react";
import { Btn } from "../ui";
import { CDIcon } from "../icons";
import type { OrderViewVM, OrdersListParams } from "~/lib/dashboard/orders-client";
import { SYSTEM_VIEWS } from "./orders-list-state";

const SORT_OPTIONS: { value: NonNullable<OrdersListParams["sort"]>; label: string }[] = [
  { value: "date", label: "Date" },
  { value: "total", label: "Total" },
  { value: "customer", label: "Customer" },
];

/** Orders screen toolbar (Phase 2 Task 6): search, sort, Export CSV, and the view-tab row
 *  (system tabs + saved views). A pure display/controlled component — Orders.tsx owns every bit
 *  of state and passes it down, so this file never touches the network or the screen cache. */
export default function OrdersToolbar({
  view,
  savedViews,
  onViewChange,
  onDeleteView,
  searchInput,
  onSearchInputChange,
  sort,
  dir,
  onSortChange,
  onDirChange,
  canSaveView,
  onSaveView,
  exportHref,
}: {
  view: string;
  savedViews: OrderViewVM[];
  onViewChange: (view: string) => void;
  onDeleteView: (id: string) => void;
  searchInput: string;
  onSearchInputChange: (value: string) => void;
  sort: OrdersListParams["sort"];
  dir: OrdersListParams["dir"];
  onSortChange: (sort: OrdersListParams["sort"]) => void;
  onDirChange: (dir: OrdersListParams["dir"]) => void;
  canSaveView: boolean;
  onSaveView: (name: string) => void;
  exportHref: string;
}) {
  const [savingName, setSavingName] = useState(false);
  const [nameInput, setNameInput] = useState("");

  const confirmSave = () => {
    const name = nameInput.trim();
    if (!name) return;
    onSaveView(name);
    setNameInput("");
    setSavingName(false);
  };

  return (
    <div style={{ marginBottom: 10 }}>
      <div className="flex items-center gap-2.5" style={{ flexWrap: "wrap" }}>
        <input
          className="cd-input"
          placeholder="Search orders"
          aria-label="Search orders"
          value={searchInput}
          onChange={(e) => onSearchInputChange(e.target.value)}
          style={{ width: "auto", minWidth: 220, flex: "1 1 220px" }}
        />
        <select
          className="cd-input"
          aria-label="Sort by"
          value={sort ?? "date"}
          onChange={(e) => onSortChange(e.target.value as OrdersListParams["sort"])}
          style={{ width: "auto" }}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Btn
          small
          icon={dir === "asc" ? "arrowUp" : "arrowDown"}
          onClick={() => onDirChange(dir === "asc" ? "desc" : "asc")}
        >
          {dir === "asc" ? "Asc" : "Desc"}
        </Btn>
        <Btn small icon="download" onClick={() => window.open(exportHref, "_blank")}>
          Export CSV
        </Btn>
      </div>

      <div className="flex items-center gap-2" style={{ marginTop: 10, flexWrap: "wrap" }}>
        {SYSTEM_VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className="cd-seg-btn"
            data-active={view === v.id ? "1" : "0"}
            onClick={() => onViewChange(v.id)}
          >
            {v.label}
          </button>
        ))}
        {savedViews.map((v) => (
          <span
            key={v.id}
            className="cd-seg-btn"
            data-active={view === v.id ? "1" : "0"}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
            role="button"
            tabIndex={0}
            onClick={() => onViewChange(v.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onViewChange(v.id);
            }}
          >
            {v.name}
            <button
              type="button"
              aria-label={`Delete view ${v.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onDeleteView(v.id);
              }}
              style={{
                display: "inline-flex",
                background: "none",
                border: 0,
                padding: 0,
                cursor: "pointer",
                color: "inherit",
                opacity: 0.6,
              }}
            >
              <CDIcon name="x" size={11} strokeWidth={2} />
            </button>
          </span>
        ))}

        {canSaveView && !savingName && (
          <Btn small icon="plus" onClick={() => setSavingName(true)}>
            Save view
          </Btn>
        )}
        {savingName && (
          <div className="flex items-center gap-2">
            <input
              className="cd-input"
              autoFocus
              placeholder="View name"
              aria-label="New view name"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmSave();
                if (e.key === "Escape") {
                  setSavingName(false);
                  setNameInput("");
                }
              }}
              style={{ width: 160 }}
            />
            <Btn small kind="primary" onClick={confirmSave} disabled={!nameInput.trim()}>
              Save
            </Btn>
            <Btn
              small
              onClick={() => {
                setSavingName(false);
                setNameInput("");
              }}
            >
              Cancel
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}
