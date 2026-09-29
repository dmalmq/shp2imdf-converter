import { useCallback, useEffect, useRef, useState } from "react";

import { saveIllustratorDraft, type PlacementDraft } from "../api/client";
import { isApiClientError } from "../api/errors";

export const AUTOSAVE_DELAY_MS = 800;
const RETRY_DELAY_MS = 5000;
/**
 * Browsers refuse a `keepalive` request whose body passes 64 KB. A larger draft
 * sent while the page is going away is an ordinary request and may not arrive;
 * the debounced save and the flush when the tab is hidden are what keep it.
 */
export const KEEPALIVE_LIMIT_BYTES = 60_000;

/**
 * `conflict`: another tab saved first, or the floors were assigned again;
 * saving stops so this tab never overwrites that. `gone`: the project was
 * removed from this PC.
 */
export type DraftSaveStatus = "idle" | "saving" | "saved" | "failed" | "conflict" | "gone";

/** The server copy a save builds on. */
type Base = { conversionId: string; revision: number; savedJson: string | null };

/** Key order does not matter to the server, so it must not matter here either. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item
  );
}

/**
 * Saves `draft` to the conversion `track` last named, debounced, one request
 * at a time. A draft equal to the server copy is never sent, so opening a
 * project sends nothing. Anything unsaved goes out with `keepalive` when the
 * page is hidden or the placement view unmounts.
 */
export function useDraftAutosave(
  draft: PlacementDraft | null,
  initial: { conversionId: string; revision: number; saved: PlacementDraft | null } | null = null,
  baseline = false,
  delayMs = AUTOSAVE_DELAY_MS
) {
  const [status, setStatus] = useState<DraftSaveStatus>("idle");
  const base = useRef<Base | null>(
    initial
      ? {
          conversionId: initial.conversionId,
          revision: initial.revision,
          savedJson: initial.saved ? stableJson(initial.saved) : null
        }
      : null
  );
  const latest = useRef<{ draft: PlacementDraft; json: string; baseline: boolean } | null>(null);
  const inFlight = useRef(false);
  const again = useRef(false);
  const timer = useRef<number | null>(null);
  const stopped = useRef(false);

  const unsaved = () => {
    const current = latest.current;
    const target = base.current;
    return current && target && !stopped.current && current.json !== target.savedJson
      ? { current, target }
      : null;
  };

  const schedule = useCallback(
    (delay: number) => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        void save();
      }, delay);
    },
    []
  );

  const save = async (keepalive = false) => {
    const pending = unsaved();
    if (!pending) return;
    if (inFlight.current) {
      again.current = true;
      return;
    }
    const { current, target } = pending;
    inFlight.current = true;
    setStatus("saving");
    try {
      const small = new TextEncoder().encode(current.json).length < KEEPALIVE_LIMIT_BYTES;
      const response = await saveIllustratorDraft(target.conversionId, target.revision, current.draft, {
        keepalive: keepalive && small,
        baseline: current.baseline
      });
      if (base.current !== target) return;
      target.revision = response.revision;
      target.savedJson = current.json;
      setStatus("saved");
    } catch (error) {
      if (base.current !== target) return;
      if (isApiClientError(error) && (error.code === "DRAFT_CONFLICT" || error.code === "CONVERSION_EXPIRED")) {
        stopped.current = true;
        setStatus(error.code === "DRAFT_CONFLICT" ? "conflict" : "gone");
      } else {
        setStatus("failed");
        schedule(RETRY_DELAY_MS);
      }
    } finally {
      inFlight.current = false;
      if (again.current) {
        again.current = false;
        schedule(0);
      }
    }
  };

  /** Point saves at a conversion and the revision (and draft, if any) the server holds. */
  const track = useCallback((conversionId: string, revision: number, saved: PlacementDraft | null) => {
    base.current = { conversionId, revision, savedJson: saved ? stableJson(saved) : null };
    stopped.current = false;
    setStatus("idle");
    if (unsaved()) schedule(delayMs);
  }, [delayMs, schedule]);

  useEffect(() => {
    latest.current = draft ? { draft, json: stableJson(draft), baseline } : null;
    if (unsaved()) schedule(delayMs);
  }, [draft, baseline, delayMs, schedule]);

  useEffect(() => {
    const sendNow = () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      void save(true);
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") sendNow();
    };
    window.addEventListener("pagehide", sendNow);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", sendNow);
      document.removeEventListener("visibilitychange", onHide);
      sendNow();
    };
  }, []);

  return { status, track };
}
