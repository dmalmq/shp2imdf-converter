const FEATURE_TYPE_COLORS: Record<string, string> = {
  venue: "#334155",
  footprint: "#7c3aed",
  building: "#7c3aed",
  level: "#2563eb",
  unit: "#64748b",
  opening: "#f59e0b",
  fixture: "#14b8a6",
  detail: "#6366f1",
  section: "#0f766e",
  geofence: "#16a34a",
  kiosk: "#f97316",
  facility: "#a855f7",
  amenity: "#ec4899",
  anchor: "#8b5cf6",
  address: "#64748b",
  relationship: "#64748b",
  occupant: "#64748b"
};

type Props = {
  featureType: string;
  size?: "sm" | "md";
};

export function FeatureTypeIcon({ featureType, size = "sm" }: Props) {
  const color = FEATURE_TYPE_COLORS[featureType] || "#94a3b8";
  const px = size === "sm" ? 10 : 14;

  return (
    <span
      className="inline-block shrink-0 rounded-[2px]"
      style={{ width: px, height: px, backgroundColor: color }}
      title={featureType}
    />
  );
}

export function featureTypeColor(featureType: string): string {
  return FEATURE_TYPE_COLORS[featureType] || "#94a3b8";
}
