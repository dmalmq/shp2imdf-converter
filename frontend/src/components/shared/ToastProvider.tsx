import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type ToastVariant = "info" | "success" | "error";

type ToastInput = {
  title: string;
  description?: string;
  variant?: ToastVariant;
  durationMs?: number;
};

type ToastRecord = ToastInput & {
  id: number;
  exiting: boolean;
};

type ToastContextValue = {
  pushToast: (toast: ToastInput) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const VARIANT_STYLE: Record<ToastVariant, string> = {
  info: "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)]",
  success: "border-[var(--color-success)]/30 bg-[var(--color-success-muted)] text-[var(--color-success)]",
  error: "border-[var(--color-error)]/30 bg-[var(--color-error-muted)] text-[var(--color-error)]"
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

  const contextValue = useMemo<ToastContextValue>(() => ({ pushToast }), [pushToast]);

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
                "pointer-events-auto rounded-[var(--radius-md)] border px-3 py-2.5 shadow-[var(--shadow-md)]",
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
                <button
                  type="button"
                  className="shrink-0 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[11px] opacity-60 transition-opacity hover:opacity-100"
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
