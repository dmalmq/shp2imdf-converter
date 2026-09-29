import {
  poseOf,
  type AlignmentBasis,
  type FloorPlacement,
  type PlacementState,
  type Pose
} from "../hooks/useIllustratorPlacement";
import { preferredArtworkMatchTarget } from "./artworkMatch";

/**
 * A floor is aligned while it still sits where an accepted alignment put it,
 * and what that alignment was made against has not moved. Dragging, nudging,
 * rotating, rescaling or relinking the floor reopens it; pinning does not
 * move it, so it neither aligns nor reopens a floor.
 */
export type FloorStatus =
  | { kind: "aligned"; basis: AlignmentBasis }
  | {
      kind: "needs-alignment";
      reason: "never" | "moved" | "reference-moved" | "points-changed";
    };

/** What to offer first for a floor that needs aligning. */
export type RecommendedAlignment =
  | { kind: "match-floor"; target: string }
  | { kind: "points" };

// About 0.1 mm on the ground, and far below anything a gesture produces:
// re-deriving a linked floor from another origin must not reopen it.
const DEGREES = 1e-9;
const RELATIVE = 1e-9;

export function samePose(a: Pose, b: Pose): boolean {
  const near = (x: number, y: number, tolerance: number) => Math.abs(x - y) <= tolerance;
  return (
    near(a.mapAnchor[0], b.mapAnchor[0], DEGREES) &&
    near(a.mapAnchor[1], b.mapAnchor[1], DEGREES) &&
    near(a.artworkAnchor[0], b.artworkAnchor[0], RELATIVE * Math.max(1, Math.abs(b.artworkAnchor[0]))) &&
    near(a.artworkAnchor[1], b.artworkAnchor[1], RELATIVE * Math.max(1, Math.abs(b.artworkAnchor[1]))) &&
    near(a.rotationDeg, b.rotationDeg, DEGREES) &&
    near(a.metresPerPoint, b.metresPerPoint, RELATIVE * b.metresPerPoint)
  );
}

export function floorStatus(state: PlacementState, floor: FloorPlacement): FloorStatus {
  const alignment = floor.alignment;
  if (!alignment) return { kind: "needs-alignment", reason: "never" };
  if (!samePose(poseOf(state, floor), alignment.pose)) {
    return { kind: "needs-alignment", reason: "moved" };
  }
  const { basis } = alignment;
  if (basis.kind === "floor") {
    const reference = state.floors.find((f) => f.label === basis.floor);
    if (!reference || !samePose(poseOf(state, reference), basis.pose)) {
      return { kind: "needs-alignment", reason: "reference-moved" };
    }
  }
  if (basis.kind === "points") {
    const owner = state.floors.find((f) => f.label === basis.floor);
    const ids = owner?.controlPoints.map((p) => p.id) ?? [];
    if (ids.length !== basis.pointIds.length || ids.some((id, i) => id !== basis.pointIds[i])) {
      return { kind: "needs-alignment", reason: "points-changed" };
    }
  }
  return { kind: "aligned", basis };
}

export function floorStatuses(state: PlacementState): Map<string, FloorStatus> {
  return new Map(state.floors.map((floor) => [floor.label, floorStatus(state, floor)]));
}

export function alignedCount(state: PlacementState): number {
  return state.floors.filter((floor) => floorStatus(state, floor).kind === "aligned").length;
}

/** A floor that did not stack is matched to a floor that did; any other starts with pairs. */
export function recommendedAlignment(
  state: PlacementState,
  floor: FloorPlacement
): RecommendedAlignment {
  const target = floor.artworkMatch ? preferredArtworkMatchTarget(floor.label, state.floors) : "";
  return target ? { kind: "match-floor", target } : { kind: "points" };
}
