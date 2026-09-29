import {
  placementReducer,
  resolvedTransform,
  type PlacementState
} from "../hooks/useIllustratorPlacement";
import { floorStatus, type CurrentReferences } from "./floorStatus";
import { artworkToLngLat, drawingScaleDenominator, lngLatToEnu } from "./similarity";

/** What rejoining `label` to the shared frame would change, before it is done. */
export type RelinkPreview = {
  label: string;
  scale: { from: number; to: number };
  rotation: { from: number; to: number };
  /** Floors whose drawing would move on the ground, and how far its centre goes. */
  moves: { label: string; metres: number }[];
  /** Floors now Aligned that the rejoin would reopen. */
  reopens: string[];
};

/** Below this a floor is not reported as moving: a millimetre of re-derivation, not a change. */
const STILL_METRES = 0.001;

export function relinkPreview(
  state: PlacementState,
  label: string,
  references: CurrentReferences
): RelinkPreview | null {
  const floor = state.floors.find((item) => item.label === label);
  if (!floor) return null;
  const after = placementReducer(state, { type: "relinkFloor", label });
  if (after === state) return null;
  const rejoined = after.floors.find((item) => item.label === label)!;
  const before = resolvedTransform(state, floor);
  const then = resolvedTransform(after, rejoined);

  const moves: RelinkPreview["moves"] = [];
  const reopens: string[] = [];
  after.floors.forEach((next, index) => {
    const prior = state.floors[index];
    const [minX, minY, maxX, maxY] = prior.artworkBounds;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const from = artworkToLngLat(resolvedTransform(state, prior), cx, cy);
    const to = artworkToLngLat(resolvedTransform(after, next), cx, cy);
    const [east, north] = lngLatToEnu(to[0], to[1], from[0], from[1]);
    const metres = Math.hypot(east, north);
    if (metres >= STILL_METRES) moves.push({ label: next.label, metres });
    if (
      floorStatus(state, prior, references).kind === "aligned" &&
      floorStatus(after, next, references).kind !== "aligned"
    ) {
      reopens.push(next.label);
    }
  });

  return {
    label,
    scale: {
      from: drawingScaleDenominator(before.metresPerPoint),
      to: drawingScaleDenominator(then.metresPerPoint)
    },
    rotation: { from: before.rotationDeg, to: then.rotationDeg },
    moves,
    reopens
  };
}
