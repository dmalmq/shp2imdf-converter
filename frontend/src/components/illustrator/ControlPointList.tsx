import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  currentResiduals,
  MIN_CONTROL_POINTS,
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
  const activeFloor =
    state.floors.find((floor) => floor.label === state.activeFloorLabel) ?? state.floors[0];
  const floorLabel = activeFloor?.label ?? state.activeFloorLabel;
  const controlPoints = activeFloor?.controlPoints ?? [];
  const fit = currentResiduals(state);
  const groupBlocked = mode === "group" && !activeFloor?.linked;
  const largestResidualIndex = fit
    ? fit.perPoint.reduce(
        (largest, residual, index, values) => (residual > values[largest] ? index : largest),
        0
      )
    : -1;

  const scopeGuide =
    mode === "group"
      ? t(
          `Align from ${floorLabel}. Add at least 3 matching points spread around the plan. The fit moves every linked floor together.`,
          `「${floorLabel}」を基準に位置合わせします。図面全体に分散した対応点を3点以上追加してください。リンクされたすべてのフロアが一緒に移動します。`
        )
      : t(
          `Add at least 3 matching points to fit only ${floorLabel}.`,
          `「${floorLabel}」だけを合わせるには、対応点を3点以上追加してください。`
        );

  const nextStep =
    controlPoints.length === 0
      ? t("Start with a distinctive corner.", "特徴のある角から始めてください。")
      : controlPoints.length === 1
        ? t(
            "Choose the second point far from #1.",
            "#1から離れた2点目を選択してください。"
          )
        : controlPoints.length === 2
          ? t(
              "Choose the third point away from the line between #1 and #2.",
              "#1と#2を結ぶ線から離れた3点目を選択してください。"
            )
          : t(
              "Ready to fit. Add more pairs if the reference is noisy.",
              "位置合わせの準備ができました。参照データに誤差がある場合は対応点を追加してください。"
            );

  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{t("Control points", "基準点")}</span>
        <Button
          size="sm"
          variant={pickStage ? "primary" : "secondary"}
          disabled={groupBlocked}
          onClick={onTogglePicking}
        >
          {pickStage === "artwork"
            ? t("Click a point on the plan...", "図面上の点をクリック...")
            : pickStage === "map"
              ? t("Click the same point on the map...", "地図上の同じ点をクリック...")
              : t("Add matching pair", "対応点を追加")}
        </Button>
      </div>

      <p className="text-xs text-[var(--color-text-muted)]">{scopeGuide}</p>
      <p className="text-xs font-medium">
        {t(
          `${controlPoints.length} / ${MIN_CONTROL_POINTS} minimum`,
          `最低${MIN_CONTROL_POINTS}点中${controlPoints.length}点`
        )}
      </p>
      <p className="text-xs text-[var(--color-text-muted)]">{nextStep}</p>

      {groupBlocked ? (
        <p className="text-xs text-[var(--color-error)]">
          {t(
            `Relink ${floorLabel} before fitting all floors.`,
            `すべてのフロアを合わせる前に「${floorLabel}」を再リンクしてください。`
          )}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
        <span className="inline-flex items-center gap-1">
          <span
            aria-hidden="true"
            className="size-2 rounded-full border border-white bg-[#2563eb]"
          />
          {t("Artwork position", "図面上の位置")}
        </span>
        <span className="inline-flex items-center gap-1">
          <span
            aria-hidden="true"
            className="size-2 rounded-full border border-white bg-[#f59e0b]"
          />
          {t("Reference target", "参照先")}
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true" className="h-0.5 w-3 bg-[#dc2626]" />
          {t("Residual", "ずれ")}
        </span>
      </div>

      {controlPoints.length > 0 ? (
        <ul className="space-y-1">
          {controlPoints.map((point, index) => (
            <li key={point.id} className="flex items-center justify-between text-xs">
              <span>
                #{index + 1} ({point.artwork[0].toFixed(1)}, {point.artwork[1].toFixed(1)}) pt
                {fit ? ` — ${fit.perPoint[index].toFixed(2)} m` : ""}
                {fit && index === largestResidualIndex
                  ? ` — ${t("Largest mismatch", "最大のずれ")}`
                  : ""}
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
      ) : null}

      {fit ? (
        <p className="text-xs">
          {t("Current RMSE", "現在のRMSE")}: <strong>{fit.rmse.toFixed(2)} m</strong>
        </p>
      ) : null}

      <Button
        size="sm"
        className="w-full"
        disabled={groupBlocked || controlPoints.length < MIN_CONTROL_POINTS}
        onClick={() => dispatch({ type: "fitControlPoints", mode })}
      >
        {mode === "group"
          ? t("Fit all linked floors", "リンクした全フロアを合わせる")
          : t("Fit this floor", "このフロアを合わせる")}
      </Button>
    </div>
  );
}
