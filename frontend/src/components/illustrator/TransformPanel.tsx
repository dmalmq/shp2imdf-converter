import { useEffect, useRef, useState } from "react";
import { Redo2, Undo2 } from "lucide-react";

import { geocodeSearch, type GeocodeResultItem } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  resolvedTransform,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { Button } from "../ui";

type Props = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  /** Building name from the drawing's file name; searched once to pre-locate. */
  siteName?: string;
  /** Reports a chosen location so the map camera can follow it. */
  onLocate?: (lngLat: [number, number]) => void;
  canUndo?: boolean;
  canRedo?: boolean;
};

const FIELD = "w-full rounded-[var(--radius-md)] border px-2 py-1";

export function TransformPanel({
  state,
  dispatch,
  siteName,
  onLocate,
  canUndo = false,
  canRedo = false
}: Props) {
  const { t, uiLanguage } = useUiLanguage();
  const [query, setQuery] = useState(siteName ?? "");
  const [results, setResults] = useState<GeocodeResultItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [autoLocated, setAutoLocated] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const searchedFor = useRef<string | null>(null);

  const runSearch = async (term: string): Promise<GeocodeResultItem[]> => {
    const trimmed = term.trim();
    if (!trimmed) return [];
    setSearching(true);
    setSearchError(null);
    try {
      const found = await geocodeSearch(trimmed, uiLanguage);
      setResults(found);
      return found;
    } catch {
      // Search is a convenience; placement stays usable by panning.
      setSearchError(
        t(
          "Address search is unavailable. Pan the map to the building instead.",
          "住所検索を利用できません。地図を手動で移動してください。"
        )
      );
      setResults([]);
      return [];
    } finally {
      setSearching(false);
    }
  };

  const locate = (result: GeocodeResultItem, baseline = false) => {
    dispatch({
      type: "positionBuilding",
      mapAnchor: [result.longitude, result.latitude],
      baseline
    });
    onLocate?.([result.longitude, result.latitude]);
  };

  // Pre-locate from the file name: search once per drawing and take the first
  // match, so the map opens on the likely building. The candidates stay listed
  // so a wrong guess is one click to correct.
  useEffect(() => {
    const name = siteName?.trim();
    if (!name || searchedFor.current === name) return;
    searchedFor.current = name;
    setQuery(name);
    void runSearch(name).then((found) => {
      if (found.length === 0) return;
      // Baseline, not an edit: Ctrl+Z must not fling the plan back to a default.
      locate(found[0], true);
      setAutoLocated(true);
    });
  }, [siteName]);

  const activeFloor = state.floors.find((f) => f.label === state.activeFloorLabel) ?? state.floors[0];
  // An unlinked floor owns its rotation/scale; the panel must show and edit
  // those instead of the frame's.
  const activeTransform = activeFloor ? resolvedTransform(state, activeFloor) : null;

  return (
    <div className="space-y-4 text-sm">
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
      <p className="-mt-2 text-xs text-[var(--color-text-muted)]">
        {t(
          "Drag a floor to move it. Corners scale, top handle rotates.",
          "ドラッグでフロアを移動。四隅で拡大縮小、上のハンドルで回転。"
        )}
      </p>
      {helpOpen ? (
        <p className="-mt-2 rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] p-2 text-xs text-[var(--color-text-secondary)]">
          {t(
            "Alt+drag moves the whole building. Ctrl+Z / Ctrl+Shift+Z undo and redo. Arrow keys nudge 1 m, Shift+arrows 10 m. Hold Shift while rotating to snap to 15°.",
            "Alt＋ドラッグで建物全体を移動。Ctrl+Z / Ctrl+Shift+Z で元に戻す・やり直す。矢印キーで1m、Shift＋矢印で10m移動。回転中に Shift で15度刻み。"
          )}
        </p>
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
        <label className="block text-xs font-medium">{t("Find the building", "建物を検索")}</label>
        <div className="mt-1 flex gap-2">
          <input
            className={FIELD}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runSearch(query);
            }}
            placeholder={t("e.g. 新宿駅", "例: 新宿駅")}
          />
          <Button
            size="sm"
            onClick={() => void runSearch(query)}
            disabled={searching || !query.trim()}
          >
            {searching ? t("Searching...", "検索中...") : t("Search", "検索")}
          </Button>
        </div>
        {searchError ? (
          <p className="mt-1 text-xs text-[var(--color-error)]">{searchError}</p>
        ) : null}
        {results.length > 0 ? (
          <ul className="mt-1 max-h-40 overflow-auto rounded-[var(--radius-md)] border">
            {results.map((result) => (
              <li key={`${result.latitude},${result.longitude}`}>
                <button
                  type="button"
                  className="w-full px-2 py-1 text-left text-xs hover:bg-black/5"
                  onClick={() => {
                    locate(result);
                    setAutoLocated(false);
                  }}
                >
                  {result.display_name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {autoLocated ? (
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {t(
              "Placed at the first match for the file name. Pick another result if this is the wrong place.",
              "ファイル名の最初の候補に配置しました。異なる場合は他の候補を選んでください。"
            )}
          </p>
        ) : null}
      </section>

      <section>
        <label className="block text-xs font-medium">
          {t("Rotation (from true north)", "回転（真北基準）")}
          {activeFloor && !activeFloor.linked ? (
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
              if (activeFloor?.linked) {
                dispatch({ type: "rotateFrame", rotationDeg });
              } else if (activeFloor) {
                dispatch({ type: "rotateFloor", label: activeFloor.label, rotationDeg });
              }
            }}
          />
          <span className="text-xs text-[var(--color-text-muted)]">°</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              activeFloor?.linked
                ? dispatch({ type: "rotateFrame", rotationDeg: 0 })
                : activeFloor &&
                  dispatch({ type: "rotateFloor", label: activeFloor.label, rotationDeg: 0 })
            }
          >
            {t("Reset", "リセット")}
          </Button>
        </div>
      </section>
    </div>
  );
}
