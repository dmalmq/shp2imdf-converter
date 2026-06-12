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

const FOOTPRINT_CATEGORY_ORDER = ["aerial", "ground", "subterranean"];

/** Category of a footprint feature, or null for non-footprints / uncategorized. */
export function footprintCategory(feature: ReviewFeature): string | null {
  if (feature.feature_type !== "footprint") {
    return null;
  }
  const category = feature.properties.category;
  return typeof category === "string" && category ? category : null;
}

/**
 * Map-layer identity for a feature. Footprints are split per category band so
 * each (aerial/ground/subterranean) can be toggled independently; everything
 * else is keyed by its feature type.
 */
export function featureLayerKey(feature: ReviewFeature): string {
  const category = footprintCategory(feature);
  return category ? `footprint:${category}` : feature.feature_type;
}

/** Underlying feature type of a layer key (e.g. "footprint:aerial" -> "footprint"). */
export function layerKeyBaseType(key: string): string {
  const separator = key.indexOf(":");
  return separator === -1 ? key : key.slice(0, separator);
}

/** Human-readable label for a layer key (e.g. "footprint:aerial" -> "Aerial Footprint"). */
export function layerKeyLabel(key: string): string {
  const separator = key.indexOf(":");
  if (separator === -1) {
    return key;
  }
  const base = key.slice(0, separator);
  const category = key.slice(separator + 1);
  const capitalized = category.charAt(0).toUpperCase() + category.slice(1);
  return base === "footprint" ? `${capitalized} Footprint` : key;
}

/**
 * Ordered list of map-layer keys for the layer panel: the located feature-type
 * order, but with the single "footprint" slot expanded into one key per
 * category band present (aerial, ground, subterranean).
 */
export function orderedLayerKeys(features: ReviewFeature[]): string[] {
  const baseTypes = orderedLocatedFeatureTypes(features);
  const footprintKeys = new Set<string>();
  features.forEach((feature) => {
    if (isLocatedFeature(feature) && feature.feature_type === "footprint") {
      footprintKeys.add(featureLayerKey(feature));
    }
  });
  const orderedFootprintKeys = [...footprintKeys].sort((left, right) => {
    const leftCat = left.includes(":") ? left.slice(left.indexOf(":") + 1) : "";
    const rightCat = right.includes(":") ? right.slice(right.indexOf(":") + 1) : "";
    const leftOrder = FOOTPRINT_CATEGORY_ORDER.indexOf(leftCat);
    const rightOrder = FOOTPRINT_CATEGORY_ORDER.indexOf(rightCat);
    const leftRank = leftOrder === -1 ? FOOTPRINT_CATEGORY_ORDER.length : leftOrder;
    const rightRank = rightOrder === -1 ? FOOTPRINT_CATEGORY_ORDER.length : rightOrder;
    return leftRank !== rightRank ? leftRank - rightRank : leftCat.localeCompare(rightCat);
  });

  const keys: string[] = [];
  baseTypes.forEach((type) => {
    if (type === "footprint") {
      keys.push(...orderedFootprintKeys);
    } else {
      keys.push(type);
    }
  });
  return keys;
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
