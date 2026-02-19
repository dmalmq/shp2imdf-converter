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
};

type ToastContextValue = {
  pushToast: (toast: ToastInput) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const VARIANT_STYLE: Record<ToastVariant, string> = {
  info: "border-slate-300 bg-white text-slate-900",
  success: "border-emerald-300 bg-emerald-50 text-emerald-900",
  error: "border-red-300 bg-red-50 text-red-900"
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);

  const removeToast = useCallback((id: number) => {
    setToasts((previous) => previous.filter((item) => item.id !== id));
  }, []);

  const pushToast = useCallback(
    (toast: ToastInput) => {
      const id = Date.now() + Math.floor(Math.random() * 1000);
      const durationMs = toast.durationMs ?? 5000;
      setToasts((previous) => [...previous, { ...toast, id }]);
      window.setTimeout(() => removeToast(id), durationMs);
    },
    [removeToast]
  );

  const contextValue = useMemo<ToastContextValue>(() => ({ pushToast }), [pushToast]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-[60] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((toast) => {
          const variant = toast.variant ?? "info";
          return (
            <div
              key={toast.id}
              className={`pointer-events-auto rounded border px-3 py-2 shadow ${VARIANT_STYLE[variant]}`}
              role="status"
              aria-live="polite"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{toast.title}</p>
                  {toast.description ? <p className="mt-0.5 text-xs opacity-90">{toast.description}</p> : null}
                </div>
                <button
                  type="button"
                  className="rounded border border-current px-1.5 py-0.5 text-[11px]"
                  onClick={() => removeToast(toast.id)}
                >
                  Close
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
