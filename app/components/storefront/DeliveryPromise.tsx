import { useState } from "react";
import { formatMoney as fmtMoney } from "~/lib/storefront/money";

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

export function DeliveryPromise({ variantId }: { variantId: string }) {
  const [zip, setZip] = useState("");
  const [est, setEst] = useState<Estimate | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "none" | "restricted">("idle");

  async function check() {
    if (!/^\d{5}$/.test(zip)) return;
    setState("loading");
    setEst(null);
    try {
      const res = await fetch(
        `/storefront/api/delivery-promise?variantId=${encodeURIComponent(variantId)}&qty=1&zip=${zip}&country=US`,
      );
      if (!res.ok) {
        // The API returns only an error CODE (no internals); a restriction gets its
        // own honest message instead of the generic "no estimate".
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setState(body?.error === "SHIP_RESTRICTED" ? "restricted" : "none");
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
      {state === "restricted" && (
        <p className="cd-pdp__promise-line">This item can&apos;t be shipped to that location.</p>
      )}
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
