import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  currentResiduals,
  MIN_CONTROL_POINTS,
  type AdjustmentMode,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { Button } from "../ui/button";
import { DisabledHint } from "../ui/tooltip";
import { OVERLAY_COLORS } from "./overlayColors";

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
  const pinnedBlocked = Boolean(activeFloor?.pinned);
  const groupBlocked = !pinnedBlocked && mode === "group" && !activeFloor?.linked;
  const enoughPoints = controlPoints.length >= MIN_CONTROL_POINTS;
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

  const addLabel =
    pickStage === "artwork"
      ? t("Click a point on the plan...", "図面上の点をクリック...")
      : pickStage === "map"
        ? t("Click the same point on the map...", "地図上の同じ点をクリック...")
        : t("Add matching pair", "対応点を追加");

  const addButton = (
    <Button
      size="sm"
      variant={pickStage ? "default" : "outline"}
      disabled={groupBlocked || pinnedBlocked}
      onClick={onTogglePicking}
    >
      {addLabel}
    </Button>
  );

  const fitLabel =
    mode === "group"
      ? t("Fit all linked floors", "リンクした全フロアを合わせる")
      : t("Fit this floor", "このフロアを合わせる");

  const fitButton = (
    <Button
      className="w-full"
      disabled={groupBlocked || pinnedBlocked || !enoughPoints}
      onClick={() => dispatch({ type: "fitControlPoints", mode })}
    >
      {fitLabel}
    </Button>
  );

  // Why the action is unavailable belongs on the action, not in a paragraph
  // further up the panel.
  const fitBlockedReason = pinnedBlocked
    ? t(
        `Unpin ${floorLabel} before fitting it with control points.`,
        `基準点で合わせる前に「${floorLabel}」の固定を解除してください。`
      )
    : groupBlocked
    ? t(
        `Relink ${floorLabel} to fit all floors`,
        `すべてのフロアを合わせるには「${floorLabel}」を再リンクしてください`
      )
    : t(
        `Add ${MIN_CONTROL_POINTS - controlPoints.length} more matching ${
          MIN_CONTROL_POINTS - controlPoints.length === 1 ? "point" : "points"
        } to enable`,
        `あと${MIN_CONTROL_POINTS - controlPoints.length}点追加すると有効になります`
      );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium leading-[18px] text-foreground">
          {t("Control points", "基準点")}
        </span>
        <DisabledHint
          className="w-auto"
          hint={
            pinnedBlocked
              ? t(
                  `Unpin ${floorLabel} before adding control points`,
                  `基準点を追加する前に「${floorLabel}」の固定を解除してください`
                )
              : groupBlocked
              ? t(
                  `Relink ${floorLabel} to add points for every floor`,
                  `全フロアに対応点を追加するには「${floorLabel}」を再リンクしてください`
                )
              : null
          }
        >
          {addButton}
        </DisabledHint>
      </div>

      <p className="text-xs leading-4 text-muted-foreground">{scopeGuide}</p>

      <div className="flex flex-col gap-1">
        <p className="font-mono text-[11px] leading-[14px] tracking-[0.02em] text-foreground">
          {t(
            `${controlPoints.length} / ${MIN_CONTROL_POINTS} minimum`,
            `最低${MIN_CONTROL_POINTS}点中${controlPoints.length}点`
          )}
        </p>
        {/* Three segments, one per required pair — the count and the progress
            say the same thing, so the bar carries no text of its own. */}
        <div className="flex gap-1" aria-hidden="true">
          {Array.from({ length: MIN_CONTROL_POINTS }, (_, index) => (
            <span
              key={index}
              className={`h-1 flex-1 rounded-full ${
                index < controlPoints.length ? "bg-signal" : "bg-border"
              }`}
            />
          ))}
        </div>
        <p className="text-xs leading-4 text-muted-foreground">{nextStep}</p>
      </div>

      {pinnedBlocked ? (
        <p className="text-xs leading-4 text-destructive">
          {t(
            `Unpin ${floorLabel} before fitting it with control points.`,
            `基準点で合わせる前に「${floorLabel}」の固定を解除してください。`
          )}
        </p>
      ) : null}

      {groupBlocked ? (
        <p className="text-xs leading-4 text-destructive">
          {t(
            `Relink ${floorLabel} before fitting all floors.`,
            `すべてのフロアを合わせる前に「${floorLabel}」を再リンクしてください。`
          )}
        </p>
      ) : null}

      {/* The legend describes markers on the map. With no pairs placed there is
          nothing out there to describe. */}
      {controlPoints.length > 0 ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] leading-4 text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span
              aria-hidden="true"
              className="size-2 rounded-full border border-background"
              style={{ backgroundColor: OVERLAY_COLORS.artwork }}
            />
            {t("Artwork position", "図面上の位置")}
          </span>
          <span className="inline-flex items-center gap-1">
            <span
              aria-hidden="true"
              className="size-2 rounded-full border border-background"
              style={{ backgroundColor: OVERLAY_COLORS.reference }}
            />
            {t("Reference target", "参照先")}
          </span>
          <span className="inline-flex items-center gap-1">
            <span
              aria-hidden="true"
              className="h-0.5 w-3"
              style={{ backgroundColor: OVERLAY_COLORS.residual }}
            />
            {t("Residual", "ずれ")}
          </span>
        </div>
      ) : null}

      {controlPoints.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {controlPoints.map((point, index) => (
            <li
              key={point.id}
              className="flex items-center justify-between gap-2 text-xs leading-4"
            >
              <span className="font-mono text-[11px] text-muted-foreground">
                #{index + 1} ({point.artwork[0].toFixed(1)}, {point.artwork[1].toFixed(1)}) pt
                {fit ? ` — ${fit.perPoint[index].toFixed(2)} m` : ""}
                {fit && index === largestResidualIndex
                  ? ` — ${t("Largest mismatch", "最大のずれ")}`
                  : ""}
              </span>
              <button
                type="button"
                className="shrink-0 rounded-sm text-xs text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => dispatch({ type: "removeControlPoint", id: point.id })}
              >
                {t("Remove", "削除")}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {fit ? (
        <p className="text-xs leading-4">
          {t("Current RMSE", "現在のRMSE")}:{" "}
          <strong className="font-mono">{fit.rmse.toFixed(2)} m</strong>
        </p>
      ) : null}

      <DisabledHint hint={pinnedBlocked || groupBlocked || !enoughPoints ? fitBlockedReason : null}>
        {fitButton}
      </DisabledHint>
    </div>
  );
}
