import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject
} from "react";

import type { PageStages, StageId } from "./stages";

/**
 * The action the top bar offers for the stage on screen. `anchor` is the
 * page's own button for the same action: the top bar shows the action only
 * while that button is out of view, so a screen never carries two of it.
 */
export type PrimaryAction = {
  label: string;
  run: () => void;
  /** Set when the action cannot run; shown as a tooltip. */
  disabledReason?: string | null;
  busy?: boolean;
  /** Things to fix, shown as a count on the button. */
  blockers?: number | null;
  anchor?: RefObject<HTMLElement | null>;
};

/**
 * What a page tells the shell about itself. The next stage's blocked reason
 * is not here: the shell takes it from the page's disabled primary action.
 */
export type PageShell = Omit<PageStages, "nextBlockedReason"> & {
  /** Station for the breadcrumb when the page knows better than the store. */
  station?: string | null;
  /** Handlers for the stages listed in `targets`. */
  go?: Partial<Record<StageId, () => void>>;
  /** Edits are on screen that the server has not been sent, and will not be until they are complete. */
  saveHeld?: boolean;
};

/**
 * Last registration wins, and removing it reveals the one below: during a
 * route change the incoming page can mount before the outgoing one unmounts.
 */
export function createSlot<T>() {
  let entries: Array<{ key: object; value: T }> = [];
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    set(key: object, value: T) {
      const index = entries.findIndex((entry) => entry.key === key);
      entries = index >= 0
        ? entries.map((entry, i) => (i === index ? { key, value } : entry))
        : [...entries, { key, value }];
      emit();
    },
    remove(key: object) {
      const next = entries.filter((entry) => entry.key !== key);
      if (next.length === entries.length) return;
      entries = next;
      emit();
    },
    get(): T | null {
      return entries.length > 0 ? entries[entries.length - 1].value : null;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

type Slot<T> = ReturnType<typeof createSlot<T>>;

type ShellSlots = { primary: Slot<PrimaryAction>; page: Slot<PageShell> };

const ShellContext = createContext<ShellSlots | null>(null);

export function ShellProvider({ children }: { children: React.ReactNode }) {
  const [slots] = useState<ShellSlots>(() => ({
    primary: createSlot<PrimaryAction>(),
    page: createSlot<PageShell>()
  }));
  return <ShellContext.Provider value={slots}>{children}</ShellContext.Provider>;
}

/** Whether the page is drawn inside the app shell, which then owns save status. */
export function useInShell(): boolean {
  return useContext(ShellContext) !== null;
}

function useSlotValue<T>(slot: Slot<T> | undefined): T | null {
  return useSyncExternalStore(
    slot ? slot.subscribe : noopSubscribe,
    () => (slot ? slot.get() : null),
    () => null
  );
}

const noopSubscribe = () => () => {};

export function useShellSlots() {
  const slots = useContext(ShellContext);
  return {
    primary: useSlotValue(slots?.primary),
    page: useSlotValue(slots?.page)
  };
}

/**
 * Registers `value` in a slot while the caller is mounted. Functions inside
 * it are called through a ref, so a page re-rendering with fresh closures
 * does not re-register; only the listed `deps` do.
 */
function useSlotRegistration<T extends object>(
  pick: (slots: ShellSlots) => Slot<T>,
  value: T | null,
  wrap: (latest: () => T) => T,
  deps: ReadonlyArray<unknown>
) {
  const slots = useContext(ShellContext);
  const key = useMemo(() => ({}), []);
  const latest = useRef(value);
  latest.current = value;
  const present = value !== null;

  useEffect(() => {
    if (!slots) return;
    const slot = pick(slots);
    if (!present) {
      slot.remove(key);
      return;
    }
    slot.set(key, wrap(() => latest.current as T));
    return () => slot.remove(key);
  }, [slots, key, present, ...deps]);
}

export function usePrimaryAction(action: PrimaryAction | null) {
  useSlotRegistration(
    (slots) => slots.primary,
    action,
    (latest) => ({ ...latest(), run: () => latest().run() }),
    [action?.label, action?.disabledReason, action?.busy, action?.blockers, action?.anchor]
  );
}

export function usePageShell(page: PageShell | null) {
  useSlotRegistration(
    (slots) => slots.page,
    page,
    (latest) => {
      const snapshot = latest();
      const go: PageShell["go"] = {};
      for (const id of Object.keys(snapshot.go ?? {}) as StageId[]) {
        go[id] = () => latest().go?.[id]?.();
      }
      return { ...snapshot, go };
    },
    [
      page?.station,
      page?.current,
      page?.targets?.join(","),
      page?.checkErrors,
      page?.checkWarnings,
      page?.bringInNeeds,
      page?.saveHeld
    ]
  );
}

/**
 * Whether `anchor` is on screen. With no anchor, or no IntersectionObserver
 * to ask, the answer is "not in view" and "in view" respectively: a missing
 * anchor means the page has no button of its own, and without an observer
 * the page's button is assumed visible rather than risk doubling it.
 */
export function useAnchorInView(anchor: RefObject<HTMLElement | null> | undefined): boolean {
  const [inView, setInView] = useState(true);
  const element = anchor?.current ?? null;

  useEffect(() => {
    if (!anchor) {
      setInView(false);
      return;
    }
    const node = anchor.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setInView(entry.intersectionRatio >= 0.5), {
      threshold: 0.5
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [anchor, element]);

  return inView;
}
