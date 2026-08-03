import { useState } from "react";

import { geocodeSearch, type GeocodeResultItem } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import type { PlacementAction, PlacementState } from "../../hooks/useIllustratorPlacement";
import { Button } from "../ui";

type Props = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
};

const FIELD = "w-full rounded-[var(--radius-md)] border px-2 py-1";

export function TransformPanel({ state, dispatch }: Props) {
  const { t, uiLanguage } = useUiLanguage();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeResultItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [denominator, setDenominator] = useState("500");
  const [artworkDistance, setArtworkDistance] = useState("");
  const [realMetres, setRealMetres] = useState("");

  const runSearch = async () => {
    setSearching(true);
    setSearchError(null);
    try {
      setResults(await geocodeSearch(query, uiLanguage));
    } catch {
      // Search is a convenience; placement stays usable by panning.
      setSearchError(
        t(
          "Address search is unavailable. Pan the map to the building instead.",
          "住所検索を利用できません。地図を手動で移動してください。"
        )
      );
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <section>
        <label className="block text-xs font-medium">{t("Find the building", "建物を検索")}</label>
        <div className="mt-1 flex gap-2">
          <input
            className={FIELD}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runSearch();
            }}
            placeholder={t("e.g. 新宿駅", "例: 新宿駅")}
          />
          <Button size="sm" onClick={() => void runSearch()} disabled={searching || !query.trim()}>
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
                  onClick={() =>
                    dispatch({
                      type: "moveAnchor",
                      mapAnchor: [result.longitude, result.latitude]
                    })
                  }
                >
                  {result.display_name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section>
        <label className="block text-xs font-medium">
          {t("Rotation (from true north)", "回転（真北基準）")}
        </label>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="number"
            step="0.1"
            className="w-24 rounded-[var(--radius-md)] border px-2 py-1"
            value={state.transform.rotationDeg}
            onChange={(event) =>
              dispatch({ type: "rotate", rotationDeg: Number(event.target.value) })
            }
          />
          <span className="text-xs text-[var(--color-text-muted)]">°</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => dispatch({ type: "rotate", rotationDeg: 0 })}
          >
            {t("Reset", "リセット")}
          </Button>
        </div>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          {t("Hold Shift while dragging to snap to 15°.", "ドラッグ中に Shift で15度刻み。")}
        </p>
      </section>

      <section>
        <label className="block text-xs font-medium">
          {t("Scale", "縮尺")}{" "}
          {state.scaleLocked ? (
            <span className="text-[var(--color-success)]">{t("(locked)", "（固定）")}</span>
          ) : null}
        </label>
        <p className="mt-1 text-xs">
          {state.transform.metresPerPoint.toFixed(6)} {t("m per point", "m/pt")}
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
    </div>
  );
}
