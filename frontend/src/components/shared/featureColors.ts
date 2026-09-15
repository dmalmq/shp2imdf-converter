/**
 * The one place IMDF feature types get a colour.
 *
 * It used to be three: a swatch table in `FeatureTypeIcon`, a `match`
 * expression in the review map and another in the wizard preview map — so a
 * footprint was purple in the list and a different purple on the map, and
 * fixture was teal in one map and purple in the other. MapLibre paint takes
 * colour strings, not CSS variables, which is why these are literals rather
 * than the `layer-1..4` tokens they mirror.
 *
 * Two bands, not a rainbow:
 *
 * - **Context** — venue, footprint, building, level, address. These are drawn
 *   under everything as the frame you work inside, so they stay neutral.
 * - **Content** — what you actually review and edit. These walk one cool ramp
 *   rather than picking a fresh hue each, and no feature type is warm: red and
 *   amber on this screen mean a validation error or warning, and nothing else.
 */

import type { DataDrivenPropertyValueSpecification } from "maplibre-gl";

const VENUE_INK = { fill: "#334155", line: "#1e293b" };
const CONTEXT = { fill: "#64748b", line: "#475569" };
const CONTEXT_LIGHT = { fill: "#94a3b8", line: "#64748b" };

const BLUE = { fill: "#2563eb", line: "#1d4ed8" };
const CYAN = { fill: "#0891b2", line: "#0e7490" };
const TEAL = { fill: "#0f766e", line: "#115e59" };
const LIME = { fill: "#65a30d", line: "#4d7c0f" };
const DEEP_BLUE = { fill: "#1d4ed8", line: "#1e40af" };
const DEEP_LIME = { fill: "#4d7c0f", line: "#3f6212" };

export type FeatureColor = { fill: string; line: string };

const FEATURE_COLORS: Record<string, FeatureColor> = {
  // Context
  venue: VENUE_INK,
  footprint: CONTEXT,
  building: CONTEXT,
  level: CONTEXT_LIGHT,
  address: CONTEXT_LIGHT,
  relationship: CONTEXT_LIGHT,
  occupant: CONTEXT_LIGHT,

  // Content, in the order they appear in the feature list
  unit: BLUE,
  opening: CYAN,
  fixture: TEAL,
  detail: LIME,
  section: DEEP_BLUE,
  geofence: DEEP_LIME,
  kiosk: TEAL,
  amenity: LIME,
  anchor: BLUE,
  facility: DEEP_BLUE
};

const FALLBACK: FeatureColor = CONTEXT_LIGHT;

export function featureColors(featureType: string): FeatureColor {
  return FEATURE_COLORS[featureType] ?? FALLBACK;
}

export function featureTypeColor(featureType: string): string {
  return featureColors(featureType).fill;
}

/**
 * Flattens the table into the `["match", input, key, value, …, fallback]` tail
 * MapLibre wants, so a paint expression cannot fall out of step with the list.
 */
export function featureColorMatchTail(which: "fill" | "line"): string[] {
  const tail: string[] = [];
  for (const [featureType, color] of Object.entries(FEATURE_COLORS)) {
    tail.push(featureType, color[which]);
  }
  tail.push(FALLBACK[which]);
  return tail;
}

/**
 * The whole `match` expression, ready to drop into a paint property.
 *
 * MapLibre types a `match` as a fixed-arity tuple, which a table of unknown
 * length cannot satisfy statically — the cast is the same one the layer
 * definitions around it already make.
 */
export function featureColorMatchExpr(
  property: string,
  which: "fill" | "line"
): DataDrivenPropertyValueSpecification<string> {
  return ["match", ["get", property], ...featureColorMatchTail(which)] as unknown as
    DataDrivenPropertyValueSpecification<string>;
}
