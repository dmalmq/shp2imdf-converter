import { featureTypeColor } from "./featureColors";

type Props = {
  featureType: string;
  size?: "sm" | "md";
};

export function FeatureTypeIcon({ featureType, size = "sm" }: Props) {
  const px = size === "sm" ? 10 : 14;

  return (
    <span
      className="inline-block shrink-0 rounded-[2px]"
      style={{ width: px, height: px, backgroundColor: featureTypeColor(featureType) }}
      title={featureType}
    />
  );
}

export { featureTypeColor };
