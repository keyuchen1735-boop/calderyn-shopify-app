// Calderyn DashV2 — Overview screen (STUB). Filled in by a later task.
import { Placeholder } from "../ui";
import type { DashboardCtx } from "../context";

export default function ScreenDashboard({ app: _app }: { app: DashboardCtx }) {
  return (
    <div className="cd-screen">
      <div className="cd-screen-head">
        <h1 className="cd-h1">Overview</h1>
      </div>
      <Placeholder title="Coming up" sub="This screen will be built in a later task." />
    </div>
  );
}
