import { useState } from "react";
import { Redo2, Undo2 } from "lucide-react";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  resolvedTransform,
  type AdjustmentMode,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { Button } from "../ui";

type Props = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  mode: AdjustmentMode;
  canUndo?: boolean;
  canRedo?: boolean;
};

export function TransformPanel({
  state,
  dispatch,
  mode,
  canUndo = false,
  canRedo = false
}: Props) {
  const { t } = useUiLanguage();
  const [helpOpen, setHelpOpen] = useState(false);

  const activeFloor = state.floors.find((f) => f.label === state.activeFloorLabel) ?? state.floors[0];
  const activeTransform = activeFloor ? resolvedTransform(state, activeFloor) : null;
  const editPerFloor = mode === "individual" || !activeFloor?.linked;

  return (
    <div className="space-y-3 text-sm">
      <section className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!canUndo}
          onClick={() => dispatch({ type: "undo" })}
        >
          <Undo2 size={13} className="mr-1" />
          {t("Undo", "元に戻す")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!canRedo}
          onClick={() => dispatch({ type: "redo" })}
        >
          <Redo2 size={13} className="mr-1" />
          {t("Redo", "やり直す")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-label={t("Keyboard and mouse help", "キーボードとマウスの操作")}
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen((open) => !open)}
        >
          ?
        </Button>
      </section>
      {helpOpen ? (
        <div className="space-y-2 rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] p-2 text-xs text-[var(--color-text-secondary)]">
          <p>
            {t(
              "Drag to move. Corners scale, top handle rotates. The map's Group/Individual switch sets whether gestures act on every floor or just this one.",
              "ドラッグで移動。四隅で拡大縮小、上のハンドルで回転。地図の「グループ／個別」スイッチで、全フロアかこの階だけかを選べます。"
            )}
          </p>
          <p>
            {t(
              "Alt+drag reverses the Group/Individual switch for one drag. Ctrl+Z / Ctrl+Shift+Z undo and redo. Arrow keys nudge 1 m, Shift+arrows 10 m. Hold Shift while rotating to snap to 15°.",
              "Alt＋ドラッグは「グループ／個別」スイッチと逆の操作を1回だけ行います。Ctrl+Z / Ctrl+Shift+Z で元に戻す・やり直す。矢印キーで1m、Shift＋矢印で10m移動。回転中に Shift で15度刻み。"
            )}
          </p>
        </div>
      ) : null}
      {activeFloor && !activeFloor.linked ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => dispatch({ type: "relinkFloor", label: activeFloor.label })}
        >
          {t("Relink to shared frame", "共通フレームに再リンク")}
        </Button>
      ) : null}

      <section>
        <label className="block text-xs font-medium">
          {t("Rotation (from true north)", "回転（真北基準）")}
          {activeFloor && editPerFloor ? (
            <span className="text-[var(--color-text-muted)]">{t(" (this floor)", "（この階）")}</span>
          ) : null}
        </label>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="number"
            step="0.1"
            className="w-24 rounded-[var(--radius-md)] border px-2 py-1"
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
          <span className="text-xs text-[var(--color-text-muted)]">°</span>
          <Button
            size="sm"
            variant="secondary"
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
      </section>
    </div>
  );
}
