import { useEffect } from "react";
import type { MapRef } from "react-map-gl/maplibre";

import type { PlacementAction } from "../../hooks/useIllustratorPlacement";
import {
  applyMatrix,
  enuToLngLat,
  lngLatToEnu,
  toEnuMatrix,
  type SimilarityTransform
} from "../../lib/similarity";

type Props = {
  transform: SimilarityTransform;
  dispatch: (action: PlacementAction) => void;
  map: MapRef | null;
  artworkBounds: [number, number, number, number];
  floorLabel: string;
  linked: boolean;
  scaleLocked: boolean;
};

const HANDLE_SOURCE = "placement-handles";
const HANDLE_LAYER = "placement-handle-circles";

/**
 * Move, rotate and scale gizmo for the active floor.
 *
 * All maths happens in the same local ENU frame the preview uses, so the
 * handles and the artwork can never disagree. Anchor drags pin the floor
 * (`dragFloor`); rotate and scale are frame operations, so they only make
 * sense while the floor is linked — an unlinked floor shows inert handles.
 */
export function TransformHandles({
  transform,
  dispatch,
  map,
  artworkBounds,
  floorLabel,
  linked,
  scaleLocked
}: Props) {
  useEffect(() => {
    if (!map) return undefined;
    const instance = map.getMap();
    const canvas = instance.getCanvas();
    const [lon0, lat0] = transform.mapAnchor;
    const matrix = toEnuMatrix(transform);
    const [minX, minY, maxX, maxY] = artworkBounds;

    const handleAt = (x: number, y: number) => {
      const [east, north] = applyMatrix(matrix, x, y);
      return enuToLngLat(east, north, lon0, lat0);
    };

    const source = instance.getSource(HANDLE_SOURCE) as
      | { setData: (data: unknown) => void }
      | undefined;
    source?.setData({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { role: "anchor" }, geometry: { type: "Point", coordinates: [lon0, lat0] } },
        { type: "Feature", properties: { role: "rotate" }, geometry: { type: "Point", coordinates: handleAt((minX + maxX) / 2, maxY) } },
        { type: "Feature", properties: { role: "scale" }, geometry: { type: "Point", coordinates: handleAt(maxX, minY) } }
      ]
    });

    let active: string | null = null;
    let frame = 0;

    const roleAt = (point: { x: number; y: number }): string | null => {
      if (!instance.getLayer(HANDLE_LAYER)) return null;
      const hits = instance.queryRenderedFeatures([point.x, point.y], { layers: [HANDLE_LAYER] });
      return (hits[0]?.properties?.role as string) ?? null;
    };

    const onDown = (event: any) => {
      const role = roleAt(event.point);
      if (!role) return;
      // Rotate/scale are frame operations; an unlinked floor cannot offer them.
      if (role !== "anchor" && !linked) return;
      if (role === "scale" && scaleLocked) return;
      active = role;
      instance.dragPan.disable();
      canvas.style.cursor = "grabbing";
      event.preventDefault();
    };

    const onMove = (event: any) => {
      if (!active) {
        canvas.style.cursor = roleAt(event.point) ? "grab" : "";
        return;
      }
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (active === "anchor") {
          dispatch({
            type: "dragFloor",
            label: floorLabel,
            mapAnchor: [event.lngLat.lng, event.lngLat.lat]
          });
          return;
        }
        // Offset of the pointer from the anchor, in ENU metres.
        const [east, north] = lngLatToEnu(event.lngLat.lng, event.lngLat.lat, lon0, lat0);

        if (active === "rotate") {
          // ENU +north is true north, which is the frame's rotation frame.
          const raw = (Math.atan2(east, north) * 180) / Math.PI;
          const snapped = event.originalEvent?.shiftKey ? Math.round(raw / 15) * 15 : raw;
          dispatch({ type: "rotateFrame", rotationDeg: snapped });
          return;
        }
        if (active === "scale") {
          const [ax, ay] = transform.artworkAnchor;
          const reach = Math.hypot(maxX - ax, minY - ay);
          if (reach > 0) {
            dispatch({ type: "scaleFrame", metresPerPoint: Math.hypot(east, north) / reach });
          }
        }
      });
    };

    const onUp = () => {
      if (!active) return;
      active = null;
      instance.dragPan.enable();
      canvas.style.cursor = "";
    };

    instance.on("mousedown", onDown);
    instance.on("mousemove", onMove);
    instance.on("mouseup", onUp);
    return () => {
      instance.off("mousedown", onDown);
      instance.off("mousemove", onMove);
      instance.off("mouseup", onUp);
      if (frame) cancelAnimationFrame(frame);
      instance.dragPan.enable();
    };
  }, [map, transform, dispatch, artworkBounds, floorLabel, linked, scaleLocked]);

  return null;
}
