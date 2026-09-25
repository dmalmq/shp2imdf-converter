import { useCallback } from "react";

import { isSessionNotFoundError, toErrorMessage } from "../api/errors";
import { useToast } from "../components/shared/ToastProvider";
import { useAppStore } from "../store/useAppStore";

type Options = {
  title?: string;
  suppressToast?: boolean;
};

/**
 * `sessionId` is the project the caller's requests were for. An error that
 * arrives after the store has moved to another project belongs to the one
 * left behind, so it is not reported: it would otherwise open the expired
 * dialog over the new project, whose "Back to projects" then clears it.
 */
export function useApiErrorHandler(sessionId?: string | null) {
  const pushToast = useToast();
  const setSessionExpiredMessage = useAppStore((state) => state.setSessionExpiredMessage);

  return useCallback(
    (error: unknown, fallbackMessage: string, options?: Options): string => {
      const message = toErrorMessage(error, fallbackMessage);
      if (sessionId !== undefined && useAppStore.getState().sessionId !== sessionId) {
        return message;
      }
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
    [pushToast, sessionId, setSessionExpiredMessage]
  );
}
