import { useState } from "react";

interface Estimate {
  cheapest: { amountCents: number; deliveryLatest: string | null; serviceName: string };
  fastest: { amountCents: number; deliveryLatest: string | null; serviceName: string };
  currency: string;
  isEstimate: boolean;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "soon";
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function fmtMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

export function DeliveryPromise({ variantId }: { variantId: string }) {
  const [zip, setZip] = useState("");
  const [est, setEst] = useState<Estimate | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "none">("idle");

  async function check() {
    if (!/^\d{5}$/.test(zip)) return;
    setState("loading");
    setEst(null);
    try {
      const res = await fetch(
        `/storefront/api/delivery-promise?variantId=${encodeURIComponent(variantId)}&qty=1&zip=${zip}&country=US`,
      );
      if (!res.ok) {
        setState("none");
        return;
      }
      setEst((await res.json()) as Estimate);
      setState("idle");
    } catch {
      setState("none");
    }
  }

  return (
    <div className="cd-pdp__promise">
      <label className="cd-pdp__promise-label">
        Estimate delivery
        <input
          className="cd-pdp__promise-zip"
          inputMode="numeric"
          maxLength={5}
          placeholder="ZIP"
          value={zip}
          onChange={(e) => setZip(e.target.value.replace(/\D/g, ""))}
          onBlur={check}
          aria-label="ZIP code for delivery estimate"
        />
      </label>
      {state === "loading" && <p className="cd-pdp__promise-line">Checking…</p>}
      {state === "none" && <p className="cd-pdp__promise-line">No estimate for that ZIP.</p>}
      {est && (
        <p className="cd-pdp__promise-line">
          Get it by <strong>{fmtDate(est.cheapest.deliveryLatest)}</strong> for{" "}
          {fmtMoney(est.cheapest.amountCents, est.currency)}
          {est.fastest.deliveryLatest !== est.cheapest.deliveryLatest && (
            <>
              {" "}
              · as fast as <strong>{fmtDate(est.fastest.deliveryLatest)}</strong> (
              {fmtMoney(est.fastest.amountCents, est.currency)})
            </>
          )}
          <span className="cd-pdp__promise-estimate"> — estimate</span>
        </p>
      )}
    </div>
  );
}
