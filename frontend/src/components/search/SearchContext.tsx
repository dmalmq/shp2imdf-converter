import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { CheckSource } from "../../lib/search/source";
import { createSlot } from "../shell/ShellContext";

type CheckSlot = ReturnType<typeof createSlot<CheckSource>>;

const SearchContext = createContext<CheckSlot | null>(null);

export function SearchProvider({ children }: { children: React.ReactNode }) {
  const [slot] = useState(() => createSlot<CheckSource>());
  return <SearchContext.Provider value={slot}>{children}</SearchContext.Provider>;
}

const noopSubscribe = () => () => {};

/** What Check on screen has lent to the search panel, or null. */
export function useCheckSource(): CheckSource | null {
  const slot = useContext(SearchContext);
  return useSyncExternalStore(
    slot ? slot.subscribe : noopSubscribe,
    () => (slot ? slot.get() : null),
    () => null
  );
}

/** Lends `source` to the search panel while the caller is mounted; nothing outside a SearchProvider. */
export function useSearchSource(source: CheckSource | null) {
  const slot = useContext(SearchContext);
  const key = useMemo(() => ({}), []);
  useEffect(() => {
    if (!slot) return;
    if (!source) {
      slot.remove(key);
      return;
    }
    slot.set(key, source);
  }, [slot, key, source]);
  useEffect(() => () => slot?.remove(key), [slot, key]);
}
