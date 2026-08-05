import { useEffect } from "react";

import { enuToLngLat, lngLatToEnu } from "../lib/similarity";
import type { PlacementAction, PlacementState } from "./useIllustratorPlacement";

type Options = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  /** False while the upload/assignment screens are showing. */
  enabled: boolean;
  onEscape?: () => void;
};

/** Metres an arrow key moves the active floor; Shift multiplies it. */
const NUDGE_METRES = 1;
const NUDGE_COARSE = 10;

const ARROW_OFFSETS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1]
};

/** True when the user is typing, so shortcuts must not steal the key. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Keyboard control for artwork placement.
 *
 * Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z (or Ctrl+Y) redoes, arrows nudge the
 * active floor by a metre (Shift: ten), and Escape leaves control-point picking.
 * A whole drag is one undo step, so Ctrl+Z reverts the gesture the user just
 * made rather than one animation frame of it.
 */
export function usePlacementShortcuts({ state, dispatch, enabled, onEscape }: Options): void {
  useEffect(() => {
    if (!enabled) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEntry(event.target)) return;

      const accel = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (accel && key === "z") {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? "redo" : "undo" });
        return;
      }
      if (accel && key === "y") {
        event.preventDefault();
        dispatch({ type: "redo" });
        return;
      }
      if (event.key === "Escape") {
        onEscape?.();
        return;
      }

      const offset = ARROW_OFFSETS[event.key];
      if (!offset || accel) return;
      const active =
        state.floors.find((floor) => floor.label === state.activeFloorLabel) ?? state.floors[0];
      if (!active) return;

      event.preventDefault();
      const step = event.shiftKey ? NUDGE_COARSE : NUDGE_METRES;
      const [lng, lat] = active.mapAnchor;
      const [east, north] = lngLatToEnu(lng, lat, lng, lat);
      const moved = enuToLngLat(east + offset[0] * step, north + offset[1] * step, lng, lat);
      // Moving a floor moves just it, so stacked plans can be nudged into
      // alignment without dragging the whole building.
      dispatch({ type: "dragFloor", label: active.label, mapAnchor: moved });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state, dispatch, enabled, onEscape]);
}
