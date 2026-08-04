import { useEffect, useRef } from "react";
import { Maximize2, RotateCw } from "lucide-react";
import type { MapMouseEvent } from "maplibre-gl";
import { Marker, type MapRef, type MarkerDragEvent } from "react-map-gl/maplibre";

import type { PlacementAction } from "../../hooks/useIllustratorPlacement";
import {
  enuToLngLat,
  lngLatToEnu,
  rotationForHandle,
  type GizmoCorner,
  type GizmoFrame,
  type SimilarityTransform
} from "../../lib/similarity";

type Props = {
  transform: SimilarityTransform;
  frame: GizmoFrame;
  dispatch: (action: PlacementAction) => void;
  map: MapRef | null;
  floorLabel: string;
  linked: boolean;
  scaleLocked: boolean;
  /** Layers that count as the floor's body, for grab-to-move. */
  bodyLayerIds: string[];
};

const HANDLE_BOX =
  "flex h-[18px] w-[18px] items-center justify-center rounded-[3px] border border-slate-700 bg-white shadow";
const HANDLE_ROUND =
  "flex h-[22px] w-[22px] items-center justify-center rounded-full border border-slate-700 bg-white shadow";

/**
 * Direct-manipulation gizmo for the active floor.
 *
 * Grab the floor plan itself to move it, the corners to scale, the handle above
 * the top edge to rotate — the same vocabulary as any drawing tool, so there is
 * nothing to learn. Scale and rotation are frame operations, so they are only
 * offered while the floor is linked; an unlinked floor can still be moved.
 *
 * All maths runs in the ENU frame the preview uses, so the gizmo and the artwork
 * can never disagree.
 */
export function TransformHandles({
  transform,
  frame,
  dispatch,
  map,
  floorLabel,
  linked,
  scaleLocked,
  bodyLayerIds
}: Props) {
    // Read by long-lived map listeners: a drag must survive the re-renders its own
    // dispatches cause, so the listeners are never resubscribed mid-gesture.
    const latest = useRef({ transform, frame, dispatch, floorLabel, bodyLayerIds, linked });
    latest.current = { transform, frame, dispatch, floorLabel, bodyLayerIds, linked };
  const shiftHeld = useRef(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      shiftHeld.current = event.shiftKey;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, []);

  // Grab-to-move on the floor plan itself.
  useEffect(() => {
    if (!map) return undefined;
    const instance = map.getMap();
    const canvas = instance.getCanvas();

    // Fixed for the whole gesture: the pointer-to-anchor offset, so the plan
    // moves with the cursor instead of snapping its anchor under it.
    let grab: { origin: [number, number]; offset: [number, number]; perFloor: boolean } | null =
      null;
    let pending: MapMouseEvent | null = null;
    let animation = 0;

    const overBody = (point: { x: number; y: number }): boolean => {
      const layers = latest.current.bodyLayerIds.filter((id) => instance.getLayer(id));
      if (!layers.length) return false;
      return instance.queryRenderedFeatures([point.x, point.y], { layers }).length > 0;
    };

    const apply = (event: MapMouseEvent) => {
      if (!grab) return;
      const [originLng, originLat] = grab.origin;
      const [east, north] = lngLatToEnu(event.lngLat.lng, event.lngLat.lat, originLng, originLat);
      const moved = enuToLngLat(
        east + grab.offset[0],
        north + grab.offset[1],
        originLng,
        originLat
      );
      // A linked floor carries the building: moving it must move the shared
      // frame, otherwise the floor unlinks and its scale/rotate handles vanish.
      // Alt+drag is the deliberate per-floor escape hatch.
      if (grab.perFloor) {
        latest.current.dispatch({
          type: "dragFloor",
          label: latest.current.floorLabel,
          mapAnchor: moved
        });
      } else {
        latest.current.dispatch({ type: "positionBuilding", mapAnchor: moved });
      }
    };

    const onDown = (event: MapMouseEvent) => {
      const target = event.originalEvent.target;
      // The corner and rotation handles run their own drags.
      if (target instanceof Element && target.closest(".maplibregl-marker")) return;
      if (!overBody(event.point)) return;
      const origin = latest.current.transform.mapAnchor;
      const [east, north] = lngLatToEnu(event.lngLat.lng, event.lngLat.lat, origin[0], origin[1]);
      grab = { origin, offset: [-east, -north], perFloor: event.originalEvent.altKey };
      instance.dragPan.disable();
      canvas.style.cursor = "grabbing";
      event.preventDefault();
    };

    const onMove = (event: MapMouseEvent) => {
      if (!grab) {
        canvas.style.cursor = overBody(event.point) ? "grab" : "";
        return;
      }
      pending = event;
      if (animation) return;
      animation = requestAnimationFrame(() => {
        animation = 0;
        if (grab && pending) apply(pending);
      });
    };

    const onUp = () => {
      if (!grab) return;
      if (animation) {
        cancelAnimationFrame(animation);
        animation = 0;
      }
      if (pending) apply(pending);
      pending = null;
      grab = null;
      latest.current.dispatch({ type: "endGesture" });
      instance.dragPan.enable();
      canvas.style.cursor = "";
    };

    instance.on("mousedown", onDown);
    instance.on("mousemove", onMove);
    instance.on("mouseup", onUp);
    // A release outside the canvas must not leave the gesture stuck on.
    window.addEventListener("mouseup", onUp);
    return () => {
      instance.off("mousedown", onDown);
      instance.off("mousemove", onMove);
      instance.off("mouseup", onUp);
      window.removeEventListener("mouseup", onUp);
      if (animation) cancelAnimationFrame(animation);
      instance.dragPan.enable();
      canvas.style.cursor = "";
    };
  }, [map]);

  const bearingTo = (event: MarkerDragEvent): number => {
    const [lng0, lat0] = latest.current.transform.mapAnchor;
    const [east, north] = lngLatToEnu(event.lngLat.lng, event.lngLat.lat, lng0, lat0);
    return (Math.atan2(east, north) * 180) / Math.PI;
  };

  const onCornerDrag = (corner: GizmoCorner) => (event: MarkerDragEvent) => {
    const { transform: current } = latest.current;
    const [lng0, lat0] = current.mapAnchor;
    const [east, north] = lngLatToEnu(event.lngLat.lng, event.lngLat.lat, lng0, lat0);
    // The corner is fixed in artwork space, so its distance from the anchor is
    // the scale denominator: dragging it out enlarges the plan uniformly.
    const reach = Math.hypot(
      corner.artwork[0] - current.artworkAnchor[0],
      corner.artwork[1] - current.artworkAnchor[1]
    );
    if (reach <= 0) return;
    latest.current.dispatch({
      type: "scaleFrame",
      metresPerPoint: Math.hypot(east, north) / reach
    });
  };

  const onRotateDrag = (event: MarkerDragEvent) => {
    const { transform: current, frame: currentFrame } = latest.current;
    const raw = rotationForHandle(
      currentFrame.rotate.artwork,
      current.artworkAnchor,
      bearingTo(event)
    );
    const rotationDeg = shiftHeld.current ? Math.round(raw / 15) * 15 : raw;
    latest.current.dispatch({ type: "rotateFrame", rotationDeg });
  };

  const endGesture = () => dispatch({ type: "endGesture" });

  return (
    <>
      {linked && !scaleLocked
        ? frame.corners.map((corner) => (
            <Marker
              key={corner.key}
              longitude={corner.lngLat[0]}
              latitude={corner.lngLat[1]}
              anchor="center"
              draggable
              onDrag={onCornerDrag(corner)}
              onDragEnd={endGesture}
            >
              <div
                className={HANDLE_BOX}
                style={{ cursor: corner.cursor }}
                title="Drag to scale"
              >
                <Maximize2 size={11} strokeWidth={2.5} className="text-slate-700" />
              </div>
            </Marker>
          ))
        : null}

      {linked ? (
        <Marker
          longitude={frame.rotate.lngLat[0]}
          latitude={frame.rotate.lngLat[1]}
          anchor="center"
          draggable
          onDrag={onRotateDrag}
          onDragEnd={endGesture}
        >
          <div
            className={HANDLE_ROUND}
            style={{ cursor: "grab" }}
            title="Drag to rotate (hold Shift to snap to 15°)"
          >
            <RotateCw size={13} strokeWidth={2.5} className="text-slate-700" />
          </div>
        </Marker>
      ) : null}
    </>
  );
}
