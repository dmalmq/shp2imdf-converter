import { useEffect, useState } from "react";

import {
  createPlacement,
  deletePlacement,
  listPlacements,
  type PlacementItem
} from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  fromTransformPayload,
  toTransformPayload,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { Button } from "../ui";

type Props = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  artworkBounds: [number, number, number, number];
};

/** Warn when a saved placement was authored against a different artboard. */
function boundsWarning(
  saved: [number, number, number, number],
  current: [number, number, number, number]
): boolean {
  const savedW = saved[2] - saved[0];
  const savedH = saved[3] - saved[1];
  if (savedW <= 0 || savedH <= 0) return false;
  return (
    Math.abs(current[2] - current[0] - savedW) / savedW > 0.01 ||
    Math.abs(current[3] - current[1] - savedH) / savedH > 0.01
  );
}

export function PlacementLibrary({ state, dispatch, artworkBounds }: Props) {
  const { t } = useUiLanguage();
  const [placements, setPlacements] = useState<PlacementItem[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

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
        transform: toTransformPayload(state.transform),
        artwork_bounds: artworkBounds
      });
      setName("");
      await refresh();
    } catch {
      setError(t("That name is already taken.", "その名前は既に使用されています。"));
    }
  };

  const apply = (placement: PlacementItem) => {
    dispatch({ type: "applyTransform", transform: fromTransformPayload(placement.transform) });
    setWarning(
      boundsWarning(placement.artwork_bounds, artworkBounds)
        ? t(
            "This drawing's artboard differs from the saved placement. Check the alignment.",
            "この図面のアートボードは保存時と異なります。位置合わせを確認してください。"
          )
        : null
    );
  };

  return (
    <div className="space-y-2 text-sm">
      <span className="text-xs font-medium">{t("Saved placements", "保存済み配置")}</span>
      <div className="flex gap-2">
        <input
          className="w-full rounded-[var(--radius-md)] border px-2 py-1"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("Building name", "建物名")}
        />
        <Button size="sm" disabled={!name.trim()} onClick={() => void save()}>
          {t("Save", "保存")}
        </Button>
      </div>
      {error ? <p className="text-xs text-[var(--color-error)]">{error}</p> : null}
      {warning ? <p className="text-xs text-[var(--color-warning)]">{warning}</p> : null}
      <ul className="space-y-1">
        {placements.map((placement) => (
          <li key={placement.id} className="flex items-center justify-between text-xs">
            <button type="button" className="text-left underline" onClick={() => apply(placement)}>
              {placement.name}
            </button>
            <button
              type="button"
              className="text-[var(--color-error)]"
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
