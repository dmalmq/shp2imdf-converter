import type { FeatureTypeGeometry, FeatureTypeOption } from "../../api/client";

export function geometryKindOf(geometry: { type: string } | null | undefined): FeatureTypeGeometry {
  if (!geometry) {
    return "null";
  }
  switch (geometry.type) {
    case "Polygon":
    case "MultiPolygon":
      return "polygon";
    case "LineString":
      return "line";
    case "Point":
      return "point";
    default:
      return "any";
  }
}

export function typeIsCompatible(option: FeatureTypeOption, kind: FeatureTypeGeometry): boolean {
  return option.geometry === "any" || option.geometry === kind;
}

export function compatibleFeatureTypes(
  options: FeatureTypeOption[],
  geometry: { type: string } | null | undefined
): FeatureTypeOption[] {
  const kind = geometryKindOf(geometry);
  return options.filter((option) => typeIsCompatible(option, kind));
}

export function categoryOptionsFor(
  options: FeatureTypeOption[],
  featureType: string
): string[] | null {
  const match = options.find((option) => option.feature_type === featureType);
  if (!match) {
    return null;
  }
  return match.categories;
}
