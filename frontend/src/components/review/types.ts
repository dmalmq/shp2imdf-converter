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

export const DEFAULT_LOCATED_FEATURE_ORDER = [
  "venue",
  "footprint",
  "level",
  "unit",
  "opening",
  "fixture",
  "detail",
  "section",
  "geofence",
  "kiosk",
  "amenity",
  "anchor",
  "relationship",
  "facility"
] as const;

export function isLocatedFeature(feature: ReviewFeature): boolean {
  return Boolean(feature.geometry);
}

export function orderedLocatedFeatureTypes(features: ReviewFeature[]): string[] {
  const discovered = new Set<string>();
  features.forEach((feature) => {
    if (!isLocatedFeature(feature)) {
      return;
    }
    discovered.add(feature.feature_type);
  });

  const order = new Map<string, number>(DEFAULT_LOCATED_FEATURE_ORDER.map((featureType, index) => [featureType, index]));
  return [...discovered].sort((left, right) => {
    const leftOrder = order.get(left);
    const rightOrder = order.get(right);
    if (leftOrder !== undefined && rightOrder !== undefined) {
      return leftOrder - rightOrder;
    }
    if (leftOrder !== undefined) {
      return -1;
    }
    if (rightOrder !== undefined) {
      return 1;
    }
    return left.localeCompare(right);
  });
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
