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
 * `draft` is null while the section has nothing unsaved, so opening a section
 * never writes. The page drops a draft once the server has stored it (see
 * `sameAsSaved`), which is what lets later server state show through instead
 * of being masked, and later re-sent, by a copy of an old edit.
 *
 * A draft the server would reject (`canSave` false) is held, not sent: it
 * stays on screen and is sent as soon as it becomes valid. Saves run one at a
 * time; an edit made while one is in flight is sent when it returns.
 *
 * `save` resolves to whether the server stored the value. A failed value goes
 * back to waiting, unless a newer edit already is, so it still counts as
 * unsaved and the next flush resends it. It is not retried on its own: a
 * backend that is down would otherwise be hammered in a loop.
 *
 * `flush` sends any waiting edit immediately. The page calls it before
 * switching section and before the tab unloads, and it runs on unmount, so
 * leaving never drops an edit still inside the debounce window. `settle`
 * flushes and waits until nothing is in flight, resolving false if an edit is
 * still unsaved. `unsaved` says whether an edit is waiting or in flight.
 */
export function useAutosave<T>(
  draft: T | null,
  save: (value: T) => Promise<boolean>,
  { canSave, delayMs = AUTOSAVE_DELAY_MS }: { canSave: boolean; delayMs?: number }
): { flush: () => void; settle: () => Promise<boolean>; unsaved: () => boolean } {
  const saveRef = useRef(save);
  saveRef.current = save;
  const pending = useRef<T | null>(null);
  const lastSent = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inFlight.current || pending.current === null) return;
    const value = pending.current;
    pending.current = null;
    lastSent.current = JSON.stringify(value);
    inFlight.current = saveRef.current(value).then(
      (stored) => {
        inFlight.current = null;
        if (stored) {
          flush();
          return;
        }
        lastSent.current = null;
        if (pending.current === null) pending.current = value;
      },
      () => {
        inFlight.current = null;
        lastSent.current = null;
        if (pending.current === null) pending.current = value;
      }
    );
  }, []);

  const settle = useCallback(async () => {
    flush();
    while (inFlight.current) await inFlight.current;
    return pending.current === null;
  }, [flush]);

  useEffect(() => {
    if (draft === null) {
      // Nothing unsaved: the next edit must be sent even if it happens to
      // match what was sent last, because the server may have moved since.
      lastSent.current = null;
      pending.current = null;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      return;
    }
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

  const unsaved = useCallback(() => inFlight.current !== null || pending.current !== null, []);

  return { flush, settle, unsaved };
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/**
 * Whether a draft holds nothing the server's copy lacks, so it can be dropped.
 *
 * The forms hold "" where the server stores null, and the server mints a new
 * `address_feature_id` on every buildings save, so neither counts as a
 * difference. Anything else does, trailing spaces included: dropping a draft
 * swaps the input to the server's trimmed value, and doing that mid-word would
 * eat the space just typed.
 */
export function sameAsSaved(draft: unknown, saved: unknown): boolean {
  if (isBlank(draft) && isBlank(saved)) return true;
  if (Array.isArray(draft) || Array.isArray(saved)) {
    return (
      Array.isArray(draft) &&
      Array.isArray(saved) &&
      draft.length === saved.length &&
      draft.every((item, index) => sameAsSaved(item, saved[index]))
    );
  }
  if (draft && saved && typeof draft === "object" && typeof saved === "object") {
    const a = draft as Record<string, unknown>;
    const b = saved as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    keys.delete("address_feature_id");
    return [...keys].every((key) => sameAsSaved(a[key], b[key]));
  }
  return draft === saved;
}
