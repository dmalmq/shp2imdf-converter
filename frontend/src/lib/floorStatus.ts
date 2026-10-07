import {
  floorResiduals,
  poseOf,
  type AlignmentBasis,
  type FloorPlacement,
  type PlacementState,
  type Pose,
  type ReferenceIdentity
} from "../hooks/useIllustratorPlacement";
import { preferredArtworkMatchTarget } from "./artworkMatch";

/**
 * A floor is aligned while it still sits where an accepted alignment put it,
 * and what that alignment was made against has not changed. Dragging, nudging,
 * rotating, rescaling or relinking the floor reopens it, and so does moving the
 * station pin or changing the reference data it was matched to; pinning does
 * not move it, so it neither aligns nor reopens a floor.
 *
 * `backend/src/artwork_draft.py` (`floor_is_aligned`) applies the same rule;
 * `floorStatus.golden.json` holds both to it.
 */
export type FloorStatus =
  | { kind: "aligned"; basis: AlignmentBasis }
  | {
      kind: "needs-alignment";
      reason: "never" | "moved" | "reference-moved" | "points-changed" | "reference-changed";
    };

/**
 * The reference data loaded now and the station pin it was queried around,
 * as the draft's view records them.
 */
export type CurrentReferences = {
  preloaded: boolean;
  uploads: readonly string[];
  removed: readonly string[];
  pin: [number, number] | null;
};

/** What to offer first for a floor that needs aligning. */
export type RecommendedAlignment =
  | { kind: "match-floor"; target: string }
  | { kind: "points" };

// About 0.1 mm on the ground, and far below anything a gesture produces:
// re-deriving a linked floor from another origin must not reopen it.
const DEGREES = 1e-9;
const RELATIVE = 1e-9;

const near = (x: number, y: number, tolerance: number) => Math.abs(x - y) <= tolerance;

export function samePose(a: Pose, b: Pose): boolean {
  return (
    near(a.mapAnchor[0], b.mapAnchor[0], DEGREES) &&
    near(a.mapAnchor[1], b.mapAnchor[1], DEGREES) &&
    near(a.artworkAnchor[0], b.artworkAnchor[0], RELATIVE * Math.max(1, Math.abs(b.artworkAnchor[0]))) &&
    near(a.artworkAnchor[1], b.artworkAnchor[1], RELATIVE * Math.max(1, Math.abs(b.artworkAnchor[1]))) &&
    near(a.rotationDeg, b.rotationDeg, DEGREES) &&
    near(a.metresPerPoint, b.metresPerPoint, RELATIVE * b.metresPerPoint)
  );
}

function samePin(a: [number, number] | null, b: [number, number] | null): boolean {
  if (!a || !b) return a === b;
  return near(a[0], b[0], DEGREES) && near(a[1], b[1], DEGREES);
}

/** The reference an alignment used is still the one loaded, queried around the same pin. */
export function sameReference(identity: ReferenceIdentity, current: CurrentReferences): boolean {
  const uploads = [...identity.uploads].sort();
  const now = [...current.uploads].sort();
  return (
    !current.removed.includes(identity.layer) &&
    identity.preloaded === current.preloaded &&
    uploads.length === now.length &&
    uploads.every((name, i) => name === now[i]) &&
    samePin(identity.pin, current.pin)
  );
}

export function floorStatus(
  state: PlacementState,
  floor: FloorPlacement,
  references: CurrentReferences
): FloorStatus {
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
  if (basis.kind === "reference" && !sameReference(basis.reference, references)) {
    return { kind: "needs-alignment", reason: "reference-changed" };
  }
  return { kind: "aligned", basis };
}

export function floorStatuses(
  state: PlacementState,
  references: CurrentReferences
): Map<string, FloorStatus> {
  return new Map(state.floors.map((floor) => [floor.label, floorStatus(state, floor, references)]));
}

export function alignedCount(state: PlacementState, references: CurrentReferences): number {
  return state.floors.filter((floor) => floorStatus(state, floor, references).kind === "aligned").length;
}

/** RMSE in metres of the pairs an Aligned floor was fitted to, when they are its own. */
export function floorFit(
  state: PlacementState,
  floor: FloorPlacement,
  references: CurrentReferences
): number | null {
  const status = floorStatus(state, floor, references);
  if (status.kind !== "aligned" || status.basis.kind !== "points" || status.basis.floor !== floor.label) {
    return null;
  }
  // The fit was accepted under the scale lock of its time; unlocking afterwards raises
  // the minimum for a new fit, not for the one this floor already has.
  return floorResiduals(state, floor, 2)?.rmse ?? null;
}

/** A floor that did not stack is matched to a floor that did; any other starts with pairs. */
export function recommendedAlignment(
  state: PlacementState,
  floor: FloorPlacement
): RecommendedAlignment {
  const target = floor.artworkMatch ? preferredArtworkMatchTarget(floor.label, state.floors) : "";
  return target ? { kind: "match-floor", target } : { kind: "points" };
}
