import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * The action the wizard footer performs for the section currently on screen.
 *
 * Every step used to carry its own Save button in its own header, so the
 * control moved, changed label and changed colour as you walked the rail. The
 * footer is one place; the step only says what saving means for it.
 */
export type WizardSaveAction = {
  run: () => void;
  canSave: boolean;
  /** Overrides the plain "Save" when the action is not a save (e.g. Generate). */
  label?: string;
  /** Shown as a tooltip when `canSave` is false. */
  blockedReason?: string | null;
};

type Registry = { set: (action: WizardSaveAction | null) => void };

const WizardSaveContext = createContext<Registry>({ set: () => {} });

export function WizardSaveProvider({
  children,
  onAction
}: {
  children: React.ReactNode;
  onAction: (action: WizardSaveAction | null) => void;
}) {
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const registry = useMemo<Registry>(() => ({ set: (action) => onActionRef.current(action) }), []);
  return <WizardSaveContext.Provider value={registry}>{children}</WizardSaveContext.Provider>;
}

/**
 * Publishes this step's save action to the footer.
 *
 * `run` is held in a ref rather than in the effect's dependencies: it closes
 * over the step's form state and so changes on every keystroke, which would
 * re-register — and therefore re-render the footer — on every character typed.
 */
export function useRegisterSave(
  run: () => void,
  { canSave, label, blockedReason }: Omit<WizardSaveAction, "run">
) {
  const registry = useContext(WizardSaveContext);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    registry.set({
      run: () => runRef.current(),
      canSave,
      label,
      blockedReason: blockedReason ?? null
    });
    return () => registry.set(null);
  }, [registry, canSave, label, blockedReason]);
}

export function useWizardSaveState() {
  const [action, setAction] = useState<WizardSaveAction | null>(null);
  return { action, setAction };
}
