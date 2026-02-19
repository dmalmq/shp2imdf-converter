import { useCallback } from "react";

import { isSessionNotFoundError, toErrorMessage } from "../api/errors";
import { useToast } from "../components/shared/ToastProvider";
import { useAppStore } from "../store/useAppStore";

type Options = {
  title?: string;
  suppressToast?: boolean;
};

export function useApiErrorHandler() {
  const pushToast = useToast();
  const setSessionExpiredMessage = useAppStore((state) => state.setSessionExpiredMessage);

  return useCallback(
    (error: unknown, fallbackMessage: string, options?: Options): string => {
      const message = toErrorMessage(error, fallbackMessage);
      if (isSessionNotFoundError(error)) {
        setSessionExpiredMessage("Your session has expired or was evicted. Please re-upload your files.");
      }
      if (!options?.suppressToast) {
        pushToast({
          title: options?.title ?? "Request failed",
          description: message,
          variant: "error"
        });
      }
      return message;
    },
    [pushToast, setSessionExpiredMessage]
  );
}
