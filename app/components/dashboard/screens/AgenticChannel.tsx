import { useEffect, useState } from "react";
import { CDIcon } from "../icons";

interface AgenticData {
  clients: { name: string; spendCapCents: number }[];
  quotesIssued: number;
  orders: {
    id: string;
    totalCents: number;
    currency: string;
    protocol: string | null;
    state: string;
    createdAt: string;
  }[];
  ordersCount: number;
  revenueCents: number;
}

function money(cents: number, cur = "usd"): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: cur.toUpperCase(),
  }).format(cents / 100);
}

export function AgenticChannel() {
  const [data, setData] = useState<AgenticData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/dashboard/api/agentic", { headers: { "x-requested-with": "dashboard" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: AgenticData) => setData(d))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
  }, []);

  if (error) {
    return (
      <div className="cd-screen">
        <p className="cd-error">Couldn&apos;t load the agentic channel: {error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="cd-screen">
        <p className="cd-muted">Loading&hellip;</p>
      </div>
    );
  }

  return (
    <div className="cd-screen cd-agentic">
      <header className="cd-screen__head">
        <CDIcon name="bot" size={22} strokeWidth={1.8} />
        <h1 className="cd-screen__title">Agentic channel</h1>
      </header>

      <div className="cd-stat-row">
        <div className="cd-stat">
          <span className="cd-stat__label">Quotes issued</span>
          <span className="cd-stat__value">{data.quotesIssued}</span>
        </div>
        <div className="cd-stat">
          <span className="cd-stat__label">Orders</span>
          <span className="cd-stat__value">{data.ordersCount}</span>
        </div>
        <div className="cd-stat">
          <span className="cd-stat__label">Revenue</span>
          <span className="cd-stat__value">{money(data.revenueCents)}</span>
        </div>
      </div>

      <section className="cd-card">
        <h2 className="cd-card__title">Connected AI clients</h2>
        {data.clients.length === 0 ? (
          <p className="cd-muted">No AI clients are authorized to transact yet.</p>
        ) : (
          <ul className="cd-list">
            {data.clients.map((c, i) => (
              <li key={i} className="cd-list__row">
                <span>{c.name}</span>
                <span className="cd-muted">cap {money(c.spendCapCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="cd-card">
        <h2 className="cd-card__title">Recent agentic orders</h2>
        {data.orders.length === 0 ? (
          <p className="cd-muted">No agentic orders yet.</p>
        ) : (
          <ul className="cd-list">
            {data.orders.map((o) => (
              <li key={o.id} className="cd-list__row">
                <span>#{o.id.slice(0, 8).toUpperCase()}</span>
                <span className="cd-muted">{o.protocol ?? "—"}</span>
                <span className={`cd-badge cd-badge--${o.state}`}>{o.state}</span>
                <span>{money(o.totalCents, o.currency)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
