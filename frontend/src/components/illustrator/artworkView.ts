import type { FillLayerSpecification, LineLayerSpecification } from "maplibre-gl";

import { layerVisibility } from "./placementMapLayers";

type FillPaint = NonNullable<FillLayerSpecification["paint"]>;
type LinePaint = NonNullable<LineLayerSpecification["paint"]>;

export type ActiveFloorAppearance = "solid" | "transparent";
export type OtherFloorsAppearance = "ghost" | "hidden";

export type ArtworkView = Readonly<{
  active: ActiveFloorAppearance;
  others: OtherFloorsAppearance;
}>;

export const DEFAULT_ARTWORK_VIEW: ArtworkView = { active: "solid", others: "ghost" };

export type FloorRole = "active" | "other";

export type FloorLayerProps = Readonly<{
  layout: Readonly<{ visibility: "visible" | "none" }>;
  fill: FillPaint;
  line: LinePaint;
}>;

const APPEARANCE = {
  solid: { fillOpacity: 0.45, lineWidth: 1, lineOpacity: 1 },
  // fill-opacity 0 is still hittable; visibility none is not.
  transparent: { fillOpacity: 0, lineWidth: 1, lineOpacity: 0.8 },
  ghost: { fillOpacity: 0.06, lineWidth: 0.5, lineOpacity: 0.35 }
} as const;

export function floorPaint(role: FloorRole, view: ArtworkView, tint: string): FloorLayerProps {
  if (role === "active") {
    const p = APPEARANCE[view.active];
    return {
      layout: { visibility: layerVisibility(true) },
      fill: {
        "fill-color": ["coalesce", ["get", "fill_color"], tint],
        "fill-opacity": p.fillOpacity
      },
      line: {
        "line-color": ["coalesce", ["get", "stroke_color"], ["get", "fill_color"], tint],
        "line-width": p.lineWidth,
        "line-opacity": p.lineOpacity
      }
    };
  }
  const p = APPEARANCE.ghost;
  return {
    layout: { visibility: layerVisibility(view.others === "ghost") },
    fill: { "fill-color": tint, "fill-opacity": p.fillOpacity },
    line: { "line-color": tint, "line-width": p.lineWidth, "line-opacity": p.lineOpacity }
  };
}

export function toggleTransparent(view: ArtworkView): ArtworkView {
  return { ...view, active: view.active === "solid" ? "transparent" : "solid" };
}

export function toggleOthersHidden(view: ArtworkView): ArtworkView {
  return { ...view, others: view.others === "ghost" ? "hidden" : "ghost" };
}
