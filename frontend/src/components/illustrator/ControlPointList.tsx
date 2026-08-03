import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  currentResiduals,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { Button } from "../ui";

type Props = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  picking: boolean;
  onTogglePicking: () => void;
};

export function ControlPointList({ state, dispatch, picking, onTogglePicking }: Props) {
  const { t } = useUiLanguage();
  const fit = currentResiduals(state);

  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{t("Control points", "基準点")}</span>
        <Button size="sm" variant={picking ? "primary" : "secondary"} onClick={onTogglePicking}>
          {picking ? t("Click the map...", "地図をクリック...") : t("Add point", "点を追加")}
        </Button>
      </div>

      {state.controlPoints.length === 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          {t(
            "Optional. Use these when the basemap shows the building.",
            "任意。地図に建物が表示されている場合に使用します。"
          )}
        </p>
      ) : (
        <ul className="space-y-1">
          {state.controlPoints.map((point, index) => (
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
        disabled={state.controlPoints.length < 2}
        onClick={() => dispatch({ type: "fitControlPoints" })}
      >
        {t("Fit to control points", "基準点に合わせる")}
      </Button>
    </div>
  );
}
