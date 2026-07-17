import { DashboardApiError } from "./api-error";

let reloadingForVersionSkew = false;
const VERSION_SKEW_RELOAD_KEY = "dashboard:version-skew-reload";

export function throwIfVersionSkew(res: Response): void {
  const isVersionSkew =
    res.status !== 401 &&
    res.status < 500 &&
    res.headers?.get("content-type")?.toLowerCase().includes("text/html");
  if (!isVersionSkew) return;

  let canReload = false;
  if (
    !reloadingForVersionSkew &&
    typeof location !== "undefined" &&
    typeof sessionStorage !== "undefined"
  ) {
    try {
      canReload = sessionStorage.getItem(VERSION_SKEW_RELOAD_KEY) !== "1";
      if (canReload) sessionStorage.setItem(VERSION_SKEW_RELOAD_KEY, "1");
    } catch {
      // If storage is unavailable, fail visibly instead of risking a reload loop.
    }
    if (canReload) {
      reloadingForVersionSkew = true;
      location.reload();
    }
  }
  throw new DashboardApiError(
    res.status,
    "version_skew",
    canReload
      ? "Dashboard updated. Reloading…"
      : "Dashboard update could not be loaded. Please reload.",
  );
}
