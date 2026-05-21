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
