import { type ComponentPropsWithoutRef, forwardRef, useCallback, useEffect, useRef, useState } from "react";
import MapGL, {
  type ErrorEvent,
  type MapProps,
  type MapRef,
  type ViewStateChangeEvent
} from "react-map-gl/maplibre";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import { attachMapHealth } from "../../lib/mapHealth";
import { Button } from "../ui";

const MAP_LIB = import("maplibre-gl");
const MAX_RECOVERY_ATTEMPTS = 3;
const HEALTHY_RESET_MS = 5000;

type Props = ComponentPropsWithoutRef<typeof MapGL>;

type CameraSnapshot = {
  longitude: number;
  latitude: number;
  zoom: number;
  bearing: number;
  pitch: number;
};

function cameraFromEvent(event: ViewStateChangeEvent): CameraSnapshot {
  const view = event.viewState;
  return {
    longitude: view.longitude,
    latitude: view.latitude,
    zoom: view.zoom,
    bearing: view.bearing,
    pitch: view.pitch
  };
}

function cameraFromMap(map: {
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  getBearing(): number;
  getPitch(): number;
}): CameraSnapshot {
  const center = map.getCenter();
  return {
    longitude: center.lng,
    latitude: center.lat,
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch()
  };
}

/**
 * Drop-in MapLibre map that remounts itself when the WebGL canvas dies
 * (white void, no pan/zoom) instead of sitting there until a full reload.
 */
export const MapView = forwardRef<MapRef, Props>(function MapView(
  {
    onLoad,
    onRemove,
    onMoveEnd,
    onError,
    mapLib,
    initialViewState,
    style,
    children,
    ...rest
  },
  ref
) {
  const { t } = useUiLanguage();
  const [generation, setGeneration] = useState(0);
  const [failed, setFailed] = useState(false);
  const attemptsRef = useRef(0);
  const detachRef = useRef<(() => void) | null>(null);
  const healthyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameraRef = useRef<CameraSnapshot | undefined>(undefined);

  const remount = useCallback(() => {
    detachRef.current?.();
    detachRef.current = null;
    if (healthyTimerRef.current !== null) {
      clearTimeout(healthyTimerRef.current);
      healthyTimerRef.current = null;
    }
    if (attemptsRef.current >= MAX_RECOVERY_ATTEMPTS) {
      setFailed(true);
      return;
    }
    attemptsRef.current += 1;
    setGeneration((value) => value + 1);
  }, []);

  const handleLoad = useCallback<NonNullable<MapProps["onLoad"]>>(
    (event) => {
      detachRef.current?.();
      const map = event.target;
      detachRef.current = attachMapHealth(map, { remount });
      if (healthyTimerRef.current !== null) {
        clearTimeout(healthyTimerRef.current);
      }
      healthyTimerRef.current = setTimeout(() => {
        attemptsRef.current = 0;
        healthyTimerRef.current = null;
      }, HEALTHY_RESET_MS);
      onLoad?.(event);
      try {
        cameraRef.current = cameraFromMap(map);
      } catch {
        /* parent onLoad may have removed the map */
      }
    },
    [onLoad, remount]
  );

  const handleRemove = useCallback<NonNullable<MapProps["onRemove"]>>(
    (event) => {
      detachRef.current?.();
      detachRef.current = null;
      onRemove?.(event);
    },
    [onRemove]
  );

  const handleMoveEnd = useCallback(
    (event: ViewStateChangeEvent) => {
      cameraRef.current = cameraFromEvent(event);
      onMoveEnd?.(event);
    },
    [onMoveEnd]
  );

  const handleError = useCallback(
    (event: ErrorEvent) => {
      onError?.(event);
      const message = String(event.error?.message ?? event.error ?? "");
      if (/not supported/i.test(message)) {
        setFailed(true);
      }
    },
    [onError]
  );

  useEffect(
    () => () => {
      detachRef.current?.();
      detachRef.current = null;
      if (healthyTimerRef.current !== null) {
        clearTimeout(healthyTimerRef.current);
      }
    },
    [generation]
  );

  const reload = () => {
    attemptsRef.current = 0;
    setFailed(false);
    setGeneration((value) => value + 1);
  };

  return (
    <div className="relative h-full w-full bg-[#e8eef4]">
      {failed ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-sm text-[var(--color-text-secondary)]">
            {t("The map stopped drawing. Reload it to continue.", "地図の描画が停止しました。再読み込みしてください。")}
          </p>
          <Button type="button" size="sm" onClick={reload}>
            {t("Reload map", "地図を再読み込み")}
          </Button>
        </div>
      ) : (
        <MapGL
          key={generation}
          ref={ref}
          mapLib={mapLib ?? MAP_LIB}
          initialViewState={cameraRef.current ?? initialViewState}
          style={{ width: "100%", height: "100%", ...style }}
          {...rest}
          onLoad={handleLoad}
          onRemove={handleRemove}
          onMoveEnd={handleMoveEnd}
          onError={handleError}
        >
          {children}
        </MapGL>
      )}
    </div>
  );
});
