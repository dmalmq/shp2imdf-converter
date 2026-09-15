import { HelpCircle, Redo2, Undo2 } from "lucide-react";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  resolvedTransform,
  type AdjustmentMode,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { drawingScaleDenominator } from "../../lib/similarity";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

type Props = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  mode: AdjustmentMode;
  canUndo?: boolean;
  canRedo?: boolean;
};

/**
 * The pinned header of the placement sidebar: history, the keyboard reference,
 * rotation, and the scale lock.
 *
 * The lock stays out of the tabs on purpose — it governs what dragging a corner
 * does, so it has to be reachable while you are on Reference or Export.
 */
export function TransformPanel({
  state,
  dispatch,
  mode,
  canUndo = false,
  canRedo = false
}: Props) {
  const { t } = useUiLanguage();

  const activeFloor = state.floors.find((f) => f.label === state.activeFloorLabel) ?? state.floors[0];
  const activeTransform = activeFloor ? resolvedTransform(state, activeFloor) : null;
  const editPerFloor = mode === "individual" || !activeFloor?.linked;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          disabled={!canUndo}
          aria-label={t("Undo", "元に戻す")}
          onClick={() => dispatch({ type: "undo" })}
        >
          <Undo2 />
        </Button>
        <Button
          variant="outline"
          size="icon"
          disabled={!canRedo}
          aria-label={t("Redo", "やり直す")}
          onClick={() => dispatch({ type: "redo" })}
        >
          <Redo2 />
        </Button>

        {/* The keyboard reference is genuinely useful and was genuinely
            undiscoverable. As an inline block it also shoved the whole panel
            down 164px on open; a popover overlays instead. */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto"
              aria-label={t("Keyboard and mouse help", "キーボードとマウスの操作")}
            >
              <HelpCircle />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 space-y-2 text-xs leading-4 text-muted-foreground">
            <p>
              {t(
                "Drag to move. Corners scale only when unlocked. The top handle rotates. The map's Group/Individual switch sets whether gestures act on every floor or just this one.",
                "ドラッグで移動。四隅での拡大縮小は固定を解除したときだけ。上のハンドルで回転。地図の「グループ／個別」スイッチで、全フロアかこの階だけかを選べます。"
              )}
            </p>
            <p>
              {t(
                "Alt+drag reverses the Group/Individual switch for one drag. Ctrl+Z / Ctrl+Shift+Z undo and redo. Arrow keys nudge 1 m, Shift+arrows 10 m. Hold Shift while rotating to snap to 15°.",
                "Alt＋ドラッグは「グループ／個別」スイッチと逆の操作を1回だけ行います。Ctrl+Z / Ctrl+Shift+Z で元に戻す・やり直す。矢印キーで1m、Shift＋矢印で10m移動。回転中に Shift で15度刻み。"
              )}
            </p>
          </PopoverContent>
        </Popover>
      </div>

      {activeFloor?.pinned ? (
        <p
          role="status"
          className="rounded-md border border-border bg-muted p-2 text-xs leading-4 text-foreground"
        >
          {t(
            `${activeFloor.label} is pinned. Unpin it on the map before changing its placement.`,
            `${activeFloor.label}は固定されています。位置を変更するには地図上で固定を解除してください。`
          )}
        </p>
      ) : null}
      {activeFloor && !activeFloor.linked && !activeFloor.pinned ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => dispatch({ type: "relinkFloor", label: activeFloor.label })}
        >
          {t("Relink to shared frame", "共通フレームに再リンク")}
        </Button>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <label className="font-mono text-[11px] uppercase leading-[14px] tracking-[0.04em] text-muted-foreground">
          {t("Rotation (from true north)", "回転（真北基準）")}
          {activeFloor && editPerFloor ? (
            <span className="normal-case tracking-normal">{t(" (this floor)", "（この階）")}</span>
          ) : null}
        </label>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            step="0.1"
            className="w-24"
            disabled={activeFloor?.pinned}
            value={activeTransform?.rotationDeg ?? state.frame.rotationDeg}
            onChange={(event) => {
              const rotationDeg = Number(event.target.value);
              if (!activeFloor) return;
              if (editPerFloor) {
                dispatch({ type: "rotateFloor", label: activeFloor.label, rotationDeg });
              } else {
                dispatch({ type: "rotateFrame", rotationDeg });
              }
            }}
          />
          <span className="text-xs text-muted-foreground">°</span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={activeFloor?.pinned}
            onClick={() =>
              activeFloor &&
              (editPerFloor
                ? dispatch({ type: "rotateFloor", label: activeFloor.label, rotationDeg: 0 })
                : dispatch({ type: "rotateFrame", rotationDeg: 0 }))
            }
          >
            {t("Reset", "リセット")}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {/* One text node: the scale reading and its lock state are asserted together. */}
        <p className="text-[13px] font-medium leading-[18px] text-foreground">
          {t("Scale", "縮尺")} 1:
          {Math.round(
            drawingScaleDenominator(activeTransform?.metresPerPoint ?? state.frame.metresPerPoint)
          )}
          {state.scaleLocked ? (
            <span className="font-normal text-success">{t(" (locked)", "（固定）")}</span>
          ) : null}
        </p>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => dispatch({ type: state.scaleLocked ? "unlockScale" : "lockScale" })}
        >
          {state.scaleLocked ? t("Unlock", "固定を解除") : t("Lock", "固定する")}
        </Button>
      </div>
    </div>
  );
}
