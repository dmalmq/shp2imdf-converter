import type { FeatureCollection } from "geojson";

export type SurveyPose = "idle" | "pending" | "ready";

export type SurveySnapTarget = {
  collection: FeatureCollection;
  pin: [number, number];
};

export function sameSurveySnap(
  snapped: SurveySnapTarget | null,
  collection: FeatureCollection | null,
  pin: [number, number] | null | undefined
): boolean {
  return Boolean(
    snapped &&
      collection &&
      pin &&
      snapped.collection === collection &&
      snapped.pin[0] === pin[0] &&
      snapped.pin[1] === pin[1]
  );
}

export function surveySnapAwaitingRetrim(
  snapped: SurveySnapTarget | null,
  collection: FeatureCollection | null,
  pin: [number, number] | null | undefined
): boolean {
  return Boolean(
    snapped &&
      collection &&
      pin &&
      snapped.collection === collection &&
      (snapped.pin[0] !== pin[0] || snapped.pin[1] !== pin[1])
  );
}

export function placementPoseReady(
  hasPin: boolean,
  surveyHasFeatures: boolean,
  surveyPose: SurveyPose,
  extras: { locateSettled?: boolean; snapMatchesCurrent?: boolean } = {}
): boolean {
  if (!hasPin) return Boolean(extras.locateSettled);
  if (!surveyHasFeatures) return true;
  return surveyPose === "ready" && extras.snapMatchesCurrent !== false;
}
