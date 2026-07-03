import { useEffect, useState } from "react";
import { Card, Placeholder } from "../ui";
import { apiGet } from "~/lib/dashboard/client";
import { formatMoney } from "~/lib/storefront/money";

// Order currency comes from external agentic protocols; a malformed or empty
// code must degrade to USD formatting, not throw out of Intl mid-render.
function orderMoney(cents: number, currency: string): string {
  try {
    return formatMoney(cents, currency || "usd");
  } catch {
    return formatMoney(cents, "usd");
  }
}

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

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="cd-stat">
      <span className="cd-stat-label">{label}</span>
      <span className="cd-stat-value tabular-nums">{value}</span>
    </Card>
  );
}

export function AgenticChannel() {
  const [data, setData] = useState<AgenticData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiGet<AgenticData>("/dashboard/api/agentic")
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="cd-screen">
      <header className="cd-screen-head" data-screen-label="Agentic channel">
        <div>
          <h1 className="cd-h1">Agentic channel</h1>
          <p className="cd-sub">Sales made for you by AI shopping assistants.</p>
        </div>
      </header>

      {error ? (
        <Card>
          <Placeholder
            icon="warn"
            title="Couldn't load the agentic channel"
            sub={error}
          />
        </Card>
      ) : !data ? (
        <Card>
          <Placeholder icon="bot" title="Loading" sub="Reading quotes, orders and connected clients." />
        </Card>
      ) : (
        <>
          <div className="cd-stat-grid">
            <Stat label="Quotes issued" value={data.quotesIssued} />
            <Stat label="Orders" value={data.ordersCount} />
            <Stat label="Revenue" value={formatMoney(data.revenueCents, "usd")} />
          </div>

          <Card pad={false}>
            <div
              className="flex items-center justify-between"
              style={{ padding: "14px 20px", borderBottom: "0.5px solid var(--hairline-strong)" }}
            >
              <h2 className="cd-h2">Connected AI clients</h2>
            </div>
            {data.clients.length === 0 ? (
              <Placeholder
                icon="bot"
                title="No AI clients yet"
                sub="Assistants you authorize to buy from your store show up here with their spend caps."
              />
            ) : (
              <div style={{ padding: "6px 20px 14px" }}>
                {data.clients.map((c, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-3"
                    style={{ padding: "10px 0", borderTop: i > 0 ? "0.5px solid var(--hairline)" : "none" }}
                  >
                    <span>{c.name}</span>
                    <span className="cd-caption">cap {formatMoney(c.spendCapCents, "usd")}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card pad={false}>
            <div
              className="flex items-center justify-between"
              style={{ padding: "14px 20px", borderBottom: "0.5px solid var(--hairline-strong)" }}
            >
              <h2 className="cd-h2">Recent agentic orders</h2>
            </div>
            {data.orders.length === 0 ? (
              <Placeholder
                icon="doc"
                title="No agentic orders yet"
                sub="Orders placed through AI assistants land here."
              />
            ) : (
              <div style={{ padding: "6px 20px 14px" }}>
                {data.orders.map((o, i) => (
                  <div
                    key={o.id}
                    className="flex items-center gap-3"
                    style={{ padding: "10px 0", borderTop: i > 0 ? "0.5px solid var(--hairline)" : "none" }}
                  >
                    <span className="tabular-nums">#{o.id.slice(0, 8).toUpperCase()}</span>
                    <span className="cd-caption">{o.protocol ?? "—"}</span>
                    <span className="cd-caption" style={{ marginLeft: "auto" }}>
                      {o.state}
                    </span>
                    <span className="tabular-nums">{orderMoney(o.totalCents, o.currency)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
