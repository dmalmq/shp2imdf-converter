import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type ToastVariant = "info" | "success" | "error";

type ToastInput = {
  title: string;
  description?: string;
  variant?: ToastVariant;
  durationMs?: number;
  /** A button on the toast; it closes the toast when pressed. */
  action?: { label: string; run: () => void };
  /** Toasts sharing a group can have their actions withdrawn together. */
  group?: string;
};

type ToastRecord = ToastInput & {
  id: number;
  exiting: boolean;
};

type ToastContextValue = {
  pushToast: (toast: ToastInput) => void;
  withdrawActions: (group: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * A toast floats over whatever is underneath, so its background has to be
 * opaque. The success and error variants were a 10% tint with nothing behind
 * it, which let the validation bar's buttons show straight through the toast
 * that was supposed to be covering them.
 */
const VARIANT_STYLE: Record<ToastVariant, string> = {
  info: "border-border bg-card text-foreground",
  success: "border-success/40 bg-card text-success",
  error: "border-destructive/40 bg-card text-destructive"
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);

  const removeToast = useCallback((id: number) => {
    setToasts((previous) => previous.filter((item) => item.id !== id));
  }, []);

  const startExit = useCallback((id: number) => {
    setToasts((previous) =>
      previous.map((item) => (item.id === id ? { ...item, exiting: true } : item))
    );
    // Remove after exit animation completes
    window.setTimeout(() => removeToast(id), 160);
  }, [removeToast]);

  const pushToast = useCallback(
    (toast: ToastInput) => {
      const id = Date.now() + Math.floor(Math.random() * 1000);
      const durationMs = toast.durationMs ?? 4000;
      setToasts((previous) => [...previous, { ...toast, id, exiting: false }]);
      window.setTimeout(() => startExit(id), durationMs);
    },
    [startExit]
  );

  const withdrawActions = useCallback((group: string) => {
    setToasts((previous) =>
      previous.some((item) => item.group === group && item.action)
        ? previous.map((item) => (item.group === group ? { ...item, action: undefined } : item))
        : previous
    );
  }, []);

  const contextValue = useMemo<ToastContextValue>(() => ({ pushToast, withdrawActions }), [pushToast, withdrawActions]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col-reverse gap-2">
        {toasts.map((toast) => {
          const variant = toast.variant ?? "info";
          return (
            <div
              key={toast.id}
              className={[
                "pointer-events-auto rounded-md border px-3 py-2.5 shadow-md",
                VARIANT_STYLE[variant],
                toast.exiting ? "animate-slide-out-right" : "animate-slide-in-right"
              ].join(" ")}
              role="status"
              aria-live="polite"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{toast.title}</p>
                  {toast.description ? <p className="mt-0.5 text-xs opacity-80">{toast.description}</p> : null}
                </div>
                {toast.action ? (
                  <button
                    type="button"
                    className="shrink-0 rounded-sm px-1.5 py-0.5 text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      toast.action?.run();
                      startExit(toast.id);
                    }}
                  >
                    {toast.action.label}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] opacity-60 transition-opacity hover:opacity-100"
                  onClick={() => startExit(toast.id)}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M3 3l6 6M9 3l-6 6" />
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return context.pushToast;
}

/** Withdraws the actions of every toast in a group, e.g. an Undo whose page has gone. */
export function useWithdrawToastActions() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useWithdrawToastActions must be used within ToastProvider");
  }
  return context.withdrawActions;
}
