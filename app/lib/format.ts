export const fmtMoney = (cents: number) => {
  const dollars = (cents ?? 0) / 100;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(dollars);
};
export const fmtMoneyDec = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format((cents ?? 0) / 100);

export const fmtRelTime = (iso: string) => {
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return "—";
  const diff = Date.now() - t.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  // "247d ago" stops being readable — past a month, the date itself is clearer.
  if (d <= 30) return `${d}d ago`;
  return t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

export const fmtAbsTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

export const shortId = (id: string) =>
  id.length > 13 ? `${id.slice(0, 8)}…` : id;

export const newId = (prefix: string) =>
  prefix + "_" + Math.random().toString(36).substring(2, 14).toUpperCase();
