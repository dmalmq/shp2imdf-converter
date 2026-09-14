export type SurveyPose = "idle" | "pending" | "ready";

export function placementPoseReady(
  hasPin: boolean,
  surveyHasFeatures: boolean,
  surveyPose: SurveyPose
): boolean {
  if (!hasPin) return false;
  if (!surveyHasFeatures) return true;
  return surveyPose === "ready";
}
