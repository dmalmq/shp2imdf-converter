import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/** How long typing has to pause before an edit is sent. */
export const AUTOSAVE_DELAY_MS = 800;

/**
 * The button the wizard footer shows for the section on screen.
 *
 * Form sections do not register one: they save as you edit (see
 * `useAutosave`), so the footer only reports save status for them. Only a
 * section whose last step is an action rather than a save — Summary's
 * Generate — puts a button there.
 */
export type WizardFooterAction = {
  run: () => void;
  label: string;
  enabled: boolean;
  /** Shown as a tooltip while `enabled` is false. */
  blockedReason?: string | null;
};

type Registry = { set: (action: WizardFooterAction | null) => void };

const WizardFooterContext = createContext<Registry>({ set: () => {} });

export function WizardFooterProvider({
  children,
  onAction
}: {
  children: React.ReactNode;
  onAction: (action: WizardFooterAction | null) => void;
}) {
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const registry = useMemo<Registry>(() => ({ set: (action) => onActionRef.current(action) }), []);
  return <WizardFooterContext.Provider value={registry}>{children}</WizardFooterContext.Provider>;
}

/**
 * Publishes this section's footer action.
 *
 * `run` is held in a ref rather than in the effect's dependencies: it closes
 * over page state and so changes on every render, which would re-register —
 * and therefore re-render the footer — each time.
 */
export function useFooterAction(run: () => void, { label, enabled, blockedReason }: Omit<WizardFooterAction, "run">) {
  const registry = useContext(WizardFooterContext);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    registry.set({ run: () => runRef.current(), label, enabled, blockedReason: blockedReason ?? null });
    return () => registry.set(null);
  }, [registry, label, enabled, blockedReason]);
}

export function useWizardFooterState() {
  const [action, setAction] = useState<WizardFooterAction | null>(null);
  return { action, setAction };
}

/**
 * Sends a section's draft to the server shortly after the operator stops
 * editing it.
 *
 * `draft` is null until the section is first edited, so opening a section
 * never writes. A draft the server would reject (`canSave` false) is held, not
 * sent: it stays on screen and is sent as soon as it becomes valid. Saves run
 * one at a time, so an older response can never land after a newer one.
 *
 * `flush` sends any waiting edit immediately. The page calls it before
 * switching section, and it runs on unmount, so leaving a section never drops
 * an edit still inside the debounce window.
 */
export function useAutosave<T>(
  draft: T | null,
  save: (value: T) => Promise<unknown>,
  { canSave, delayMs = AUTOSAVE_DELAY_MS }: { canSave: boolean; delayMs?: number }
): { flush: () => void } {
  const saveRef = useRef(save);
  saveRef.current = save;
  const pending = useRef<T | null>(null);
  const lastSent = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inFlight.current || pending.current === null) return;
    const value = pending.current;
    pending.current = null;
    lastSent.current = JSON.stringify(value);
    inFlight.current = true;
    void saveRef.current(value).finally(() => {
      inFlight.current = false;
      flush();
    });
  }, []);

  useEffect(() => {
    if (draft === null) return;
    if (!canSave || JSON.stringify(draft) === lastSent.current) {
      pending.current = null;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      return;
    }
    pending.current = draft;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, delayMs);
  }, [draft, canSave, delayMs, flush]);

  useEffect(() => flush, [flush]);

  return { flush };
}
