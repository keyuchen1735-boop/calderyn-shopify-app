import { useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

export type ActionToast = {
  ok: boolean;
  toast?: { message: string; isError?: boolean };
};

export function useActionToast(actionData: ActionToast | undefined) {
  const shopify = useAppBridge();
  const msg = actionData?.toast?.message;
  const isError = !!actionData?.toast?.isError;
  useEffect(() => {
    if (!msg) return;
    shopify.toast.show(msg, { isError, duration: 5000 });
  }, [msg, isError, shopify]);
}

export type ConnectionNotice = { provider: string; ok: boolean; reason?: string } | null;

/** Pure notice -> toast mapping for the post-OAuth pairing confirmation. */
export function connectionToast(notice: ConnectionNotice): { message: string; isError: boolean } | null {
  if (!notice) return null;
  if (notice.ok) return { message: `${notice.provider} connected`, isError: false };
  return {
    message: notice.reason
      ? `Couldn't connect ${notice.provider} (${notice.reason})`
      : `Couldn't connect ${notice.provider}`,
    isError: true,
  };
}

/** One-shot App Bridge toast for the `?<provider>=connected` redirect notice. */
export function useConnectionToast(notice: ConnectionNotice) {
  const t = connectionToast(notice);
  useActionToast(t ? { ok: !t.isError, toast: t } : undefined);
}
