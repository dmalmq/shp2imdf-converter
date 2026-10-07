import { useEffect, useState } from "react";

import {
  createPlacement,
  deletePlacement,
  listPlacements,
  type PlacementItem
} from "../../api/client";
import { isApiClientError, toErrorMessage } from "../../api/errors";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  placementReducer,
  poseOf,
  toFloorPayloads,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { floorStatus, samePose, type CurrentReferences } from "../../lib/floorStatus";
import { Button } from "../ui/button";

type Props = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  artworkBounds: [number, number, number, number];
  references: CurrentReferences;
};

/** How a saved template lines up with this drawing, shown before it is applied. */
export type TemplatePreview = {
  /** Floors here that the template places. */
  matched: string[];
  /** Floors the template names that are pinned here, so applying leaves them where they are. */
  pinned: string[];
  /** Floors here the template has nothing for that stay exactly where they are. */
  kept: string[];
  /** Floors the template has nothing for that are linked, so they take its scale and rotation. */
  reframed: string[];
  /** Floors in the template this drawing does not have. */
  unused: string[];
  /** Drawing size as saved and now, in points, when they differ by more than 1%. */
  size: { saved: [number, number]; current: [number, number] } | null;
  /** Floors now Aligned that applying would reopen. */
  reopens: string[];
};

export function templatePreview(
  state: PlacementState,
  placement: Pick<PlacementItem, "floors" | "artwork_bounds">,
  artworkBounds: [number, number, number, number],
  references: CurrentReferences
): TemplatePreview {
  const saved = new Set(placement.floors.map((f) => f.label));
  const current = new Set(state.floors.map((f) => f.label));
  const [sx0, sy0, sx1, sy1] = placement.artwork_bounds;
  const savedSize: [number, number] = [sx1 - sx0, sy1 - sy0];
  const currentSize: [number, number] = [
    artworkBounds[2] - artworkBounds[0],
    artworkBounds[3] - artworkBounds[1]
  ];
  const differs =
    savedSize[0] > 0 &&
    savedSize[1] > 0 &&
    (Math.abs(currentSize[0] - savedSize[0]) / savedSize[0] > 0.01 ||
      Math.abs(currentSize[1] - savedSize[1]) / savedSize[1] > 0.01);
  const after = placementReducer(state, { type: "applyFloors", floors: placement.floors });
  return {
    matched: state.floors.filter((f) => saved.has(f.label) && !f.pinned).map((f) => f.label),
    pinned: state.floors.filter((f) => saved.has(f.label) && f.pinned).map((f) => f.label),
    kept: state.floors
      .filter((f, index) => !saved.has(f.label) && samePose(poseOf(state, f), poseOf(after, after.floors[index])))
      .map((f) => f.label),
    reframed: state.floors
      .filter((f, index) => !saved.has(f.label) && !samePose(poseOf(state, f), poseOf(after, after.floors[index])))
      .map((f) => f.label),
    unused: placement.floors.filter((f) => !current.has(f.label)).map((f) => f.label),
    size: differs ? { saved: savedSize, current: currentSize } : null,
    reopens: state.floors
      .filter(
        (f, index) =>
          floorStatus(state, f, references).kind === "aligned" &&
          floorStatus(after, after.floors[index], references).kind !== "aligned"
      )
      .map((f) => f.label)
  };
}

export function PlacementLibrary({ state, dispatch, artworkBounds, references }: Props) {
  const { t } = useUiLanguage();
  const [placements, setPlacements] = useState<PlacementItem[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PlacementItem | null>(null);

  const refresh = async () => {
    try {
      setPlacements(await listPlacements());
    } catch {
      setError(t("Could not load saved placements.", "保存済み配置を読み込めません。"));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const save = async () => {
    setError(null);
    try {
      await createPlacement({
        name: name.trim(),
        floors: toFloorPayloads(state),
        artwork_bounds: artworkBounds
      });
      setName("");
      await refresh();
    } catch (caught) {
      setError(
        isApiClientError(caught) && caught.code === "PLACEMENT_NAME_TAKEN"
          ? t("That name is already taken.", "その名前は既に使用されています。")
          : toErrorMessage(caught, t("Could not save the placement.", "配置を保存できません。"))
      );
    }
  };

  const preview = pending ? templatePreview(state, pending, artworkBounds, references) : null;
  const size = (value: [number, number]) => `${Math.round(value[0])} × ${Math.round(value[1])} pt`;

  return (
    <div className="space-y-2 text-sm">
      <span className="text-xs font-medium">{t("Saved placements", "保存済み配置")}</span>
      <div className="flex gap-2">
        <input
          className="w-full rounded-md border px-2 py-1"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("Building name", "建物名")}
        />
        <Button size="sm" disabled={!name.trim()} onClick={() => void save()}>
          {t("Save", "保存")}
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {pending && preview ? (
        <div
          data-testid="template-preview"
          className="space-y-1.5 rounded-md border border-border bg-muted p-2.5 text-xs leading-4"
        >
          <p className="font-medium text-foreground">
            {t(`Apply “${pending.name}”?`, `「${pending.name}」を適用しますか？`)}
          </p>
          <p className="text-muted-foreground">
            {preview.matched.length > 0
              ? t(`Places ${preview.matched.join(", ")}.`, `${preview.matched.join("、")}を配置します。`)
              : t("No floor here has a name the template knows.", "テンプレートと同じ名前のフロアがありません。")}
          </p>
          {preview.pinned.length > 0 ? (
            <p className="text-warning-foreground">
              {t(
                `Pinned, so the template does not move ${preview.pinned.length === 1 ? "it" : "them"}: ${preview.pinned.join(", ")}.`,
                `ピン留め中のためテンプレートでは動きません：${preview.pinned.join("、")}`
              )}
            </p>
          ) : null}
          {preview.kept.length > 0 ? (
            <p className="text-warning-foreground">
              {t(
                `Not in the template, keeps its placement: ${preview.kept.join(", ")}.`,
                `テンプレートにないため今の配置のまま：${preview.kept.join("、")}`
              )}
            </p>
          ) : null}
          {preview.reframed.length > 0 ? (
            <p className="text-warning-foreground">
              {t(
                `Not in the template, but linked, so ${preview.reframed.length === 1 ? "it takes" : "they take"} the template's scale and rotation: ${preview.reframed.join(", ")}.`,
                `テンプレートにはないが、リンクしているためテンプレートの縮尺と回転になります：${preview.reframed.join("、")}`
              )}
            </p>
          ) : null}
          {preview.unused.length > 0 ? (
            <p className="text-warning-foreground">
              {t(
                `In the template but not in this drawing: ${preview.unused.join(", ")}.`,
                `テンプレートにあってこの図面にないフロア：${preview.unused.join("、")}`
              )}
            </p>
          ) : null}
          {preview.size ? (
            <p className="text-warning-foreground">
              {t(
                `The drawing size differs: saved ${size(preview.size.saved)}, now ${size(preview.size.current)}.`,
                `図面の大きさが違います：保存時 ${size(preview.size.saved)}、現在 ${size(preview.size.current)}`
              )}
            </p>
          ) : null}
          {preview.reopens.length > 0 ? (
            <p className="text-warning-foreground">
              {t(
                `${preview.reopens.join(", ")} will need aligning again.`,
                `${preview.reopens.join("、")}はもう一度位置合わせが必要になります。`
              )}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
              {t("Cancel", "キャンセル")}
            </Button>
            <Button
              size="sm"
              disabled={preview.matched.length === 0}
              onClick={() => {
                dispatch({ type: "applyFloors", floors: pending.floors });
                setPending(null);
              }}
            >
              {t("Apply", "適用")}
            </Button>
          </div>
        </div>
      ) : null}
      <ul className="space-y-1">
        {placements.map((placement) => (
          <li key={placement.id} className="flex items-center justify-between text-xs">
            <button type="button" className="text-left underline" onClick={() => setPending(placement)}>
              {placement.name}
            </button>
            <button
              type="button"
              className="text-destructive"
              onClick={async () => {
                await deletePlacement(placement.id);
                await refresh();
              }}
            >
              {t("Delete", "削除")}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
