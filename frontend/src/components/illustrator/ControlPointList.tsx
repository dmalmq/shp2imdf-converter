import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  currentResiduals,
  type AdjustmentMode,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { Button } from "../ui";

type Props = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  /** Pair-picking stage: pin the artwork point, then its map correspondence. */
  pickStage: "artwork" | "map" | null;
  /** What the fit acts on: the shared frame or the active floor. */
  mode: AdjustmentMode;
  onTogglePicking: () => void;
};

export function ControlPointList({ state, dispatch, pickStage, mode, onTogglePicking }: Props) {
  const { t } = useUiLanguage();
  const activeFloor = state.floors.find((f) => f.label === state.activeFloorLabel) ?? state.floors[0];
  const controlPoints = activeFloor?.controlPoints ?? [];
  const fit = currentResiduals(state);

  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{t("Control points", "基準点")}</span>
        <Button size="sm" variant={pickStage ? "primary" : "secondary"} onClick={onTogglePicking}>
          {pickStage === "artwork"
            ? t("Click a point on the plan...", "図面上の点をクリック...")
            : pickStage === "map"
              ? t("Click the same point on the map...", "地図上の同じ点をクリック...")
              : t("Add point", "点を追加")}
        </Button>
      </div>

      {controlPoints.length === 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          {t(
            "Optional. Pick two points on the plan and the same two on the map or a reference layer — position, rotation and scale then fit themselves.",
            "任意。図面上の2点と、地図または参照レイヤー上の同じ2点を選ぶと、位置・回転・縮尺が自動で合います。"
          )}
        </p>
      ) : (
        <ul className="space-y-1">
          {controlPoints.map((point, index) => (
            <li key={point.id} className="flex items-center justify-between text-xs">
              <span>
                #{index + 1} ({point.artwork[0].toFixed(1)}, {point.artwork[1].toFixed(1)}) pt
                {fit ? ` — ${fit.perPoint[index].toFixed(2)} m` : ""}
              </span>
              <button
                type="button"
                className="text-[var(--color-error)]"
                onClick={() => dispatch({ type: "removeControlPoint", id: point.id })}
              >
                {t("Remove", "削除")}
              </button>
            </li>
          ))}
        </ul>
      )}

      {fit ? (
        <p className="text-xs">
          RMSE: <strong>{fit.rmse.toFixed(2)} m</strong>
        </p>
      ) : null}

      <Button
        size="sm"
        className="w-full"
        disabled={controlPoints.length < 2}
        onClick={() => dispatch({ type: "fitControlPoints", mode })}
      >
        {t("Fit to control points", "基準点に合わせる")}
      </Button>
    </div>
  );
}
