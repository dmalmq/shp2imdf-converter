export type ReviewFeature = {
  type: string;
  id: string;
  feature_type: string;
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown>;
};

export type ReviewIssue = {
  feature_id: string | null;
  related_feature_id?: string | null;
  check: string;
  message: string;
  severity: "error" | "warning";
  auto_fixable: boolean;
  fix_description?: string | null;
  overlap_geometry?: Record<string, unknown> | null;
};

export const LOCATED_FEATURE_TYPES = ["venue", "footprint", "level", "unit", "opening", "fixture", "detail"] as const;

export function isLocatedFeature(feature: ReviewFeature): boolean {
  return Boolean(feature.geometry) && LOCATED_FEATURE_TYPES.includes(feature.feature_type as (typeof LOCATED_FEATURE_TYPES)[number]);
}

export function featureName(feature: ReviewFeature): string {
  const value = feature.properties.name;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const label = Object.values(value as Record<string, unknown>).find((item) => typeof item === "string");
    if (typeof label === "string") {
      return label;
    }
  }
  if (typeof value === "string") {
    return value;
  }
  return "";
}
