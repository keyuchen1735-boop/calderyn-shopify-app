// Calderyn DashV2 — Alerts screen (STUB). Filled in by a later task.
import { Placeholder } from "../ui";
import type { DashboardCtx } from "../context";

export default function ScreenAlerts({ app: _app }: { app: DashboardCtx }) {
  return (
    <div className="cd-screen">
      <div className="cd-screen-head">
        <h1 className="cd-h1">Alerts</h1>
      </div>
      <Placeholder title="Coming up" sub="This screen will be built in a later task." />
    </div>
  );
}
