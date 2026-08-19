import { useState } from "react";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  DEFAULT_DRAWING_SCALE,
  resolvedTransform,
  type AdjustmentMode,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { Button } from "../ui";
import { ControlPointList } from "./ControlPointList";

type Props = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  /** Pair-picking stage, forwarded to the control-point list. */
  pickStage: "artwork" | "map" | null;
  /** What fits and scale operations act on. */
  mode: AdjustmentMode;
  onTogglePicking: () => void;
};

/**
 * Everything that derives the transform numerically: the drawing scale, the
 * measured-distance calibration, and the control points that fit both at once.
 */
export function ScaleAndFitPanel({ state, dispatch, pickStage, mode, onTogglePicking }: Props) {
  const { t } = useUiLanguage();
  const [denominator, setDenominator] = useState(String(DEFAULT_DRAWING_SCALE));
  const [artworkDistance, setArtworkDistance] = useState("");
  const [realMetres, setRealMetres] = useState("");

  const activeFloor =
    state.floors.find((f) => f.label === state.activeFloorLabel) ?? state.floors[0];
  const activeTransform = activeFloor ? resolvedTransform(state, activeFloor) : null;

  return (
    <div className="space-y-4 text-sm">
      <section>
        <label className="block text-xs font-medium">
          {t("Scale", "縮尺")}{" "}
          {state.scaleLocked ? (
            <span className="text-[var(--color-success)]">{t("(locked)", "（固定）")}</span>
          ) : null}
        </label>
        <p className="mt-1 text-xs">
          {(activeTransform?.metresPerPoint ?? state.frame.metresPerPoint).toFixed(6)}{" "}
          {t("m per point", "m/pt")}
        </p>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-xs">1:</span>
          <input
            type="number"
            className="w-24 rounded-[var(--radius-md)] border px-2 py-1"
            value={denominator}
            onChange={(event) => setDenominator(event.target.value)}
          />
          <Button
            size="sm"
            onClick={() => dispatch({ type: "setDrawingScale", denominator: Number(denominator) })}
          >
            {t("Apply", "適用")}
          </Button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            type="number"
            className="w-20 rounded-[var(--radius-md)] border px-2 py-1"
            placeholder="pt"
            value={artworkDistance}
            onChange={(event) => setArtworkDistance(event.target.value)}
          />
          <span className="text-xs">=</span>
          <input
            type="number"
            className="w-20 rounded-[var(--radius-md)] border px-2 py-1"
            placeholder="m"
            value={realMetres}
            onChange={(event) => setRealMetres(event.target.value)}
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              dispatch({
                type: "calibrateDistance",
                artworkDistance: Number(artworkDistance),
                realMetres: Number(realMetres)
              })
            }
          >
            {t("Calibrate", "校正")}
          </Button>
        </div>
        {state.scaleLocked ? (
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => dispatch({ type: "unlockScale" })}
          >
            {t("Unlock scale", "縮尺の固定を解除")}
          </Button>
        ) : null}
      </section>

      <ControlPointList
        state={state}
        dispatch={dispatch}
        pickStage={pickStage}
        mode={mode}
        onTogglePicking={onTogglePicking}
      />
    </div>
  );
}
