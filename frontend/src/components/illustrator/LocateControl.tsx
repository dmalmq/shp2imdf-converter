import { useEffect, useReducer, useRef } from "react";

import { geocodeSearch } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import type { PlacementAction } from "../../hooks/useIllustratorPlacement";
import { Button } from "../ui";
import {
  INITIAL_LOCATE,
  acceptsGuess,
  locateReducer,
  locatedPlace,
  samePlace,
  toPlace,
  type Place
} from "./locateChrome";

type Props = {
  siteName: string;
  dispatch: (action: PlacementAction) => void;
  onLocate: (lngLat: [number, number]) => void;
};

const FIELD = "w-full rounded-[var(--radius-md)] border px-2 py-1";

export function LocateControl({ siteName, dispatch, onLocate }: Props) {
  const { t, uiLanguage } = useUiLanguage();
  const [locate, send] = useReducer(locateReducer, INITIAL_LOCATE);
  const locateRef = useRef(locate);
  locateRef.current = locate;
  const searchedFor = useRef<string | null>(null);

  useEffect(() => {
    const name = siteName.trim();
    if (!name || searchedFor.current === name) return;
    searchedFor.current = name;
    const armed = locateReducer(locateRef.current, { type: "armFilename", query: name });
    locateRef.current = armed;
    send({ type: "armFilename", query: name });
    void geocodeSearch(name, uiLanguage)
      .then((found) => {
        const candidates = found.map(toPlace);
        if (!acceptsGuess(locateRef.current)) return;
        if (candidates[0]) {
          dispatch({
            type: "positionBuilding",
            mapAnchor: candidates[0].lngLat,
            baseline: true
          });
          onLocate(candidates[0].lngLat);
        }
        send({ type: "guessed", candidates });
      })
      .catch(() => {
        if (acceptsGuess(locateRef.current)) send({ type: "guessed", candidates: [] });
      });
  }, [siteName, uiLanguage, dispatch, onLocate]);

  const runSearch = (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    send({ type: "submitted" });
    void geocodeSearch(trimmed, uiLanguage)
      .then((found) => {
        send({ type: "settled", query: trimmed, places: found.map(toPlace) });
      })
      .catch(() => {
        send({ type: "faulted", query: trimmed });
      });
  };

  const pick = (place: Place) => {
    const current = locatedPlace(locate.located);
    if (!current || !samePlace(current, place)) {
      dispatch({ type: "positionBuilding", mapAnchor: place.lngLat, baseline: false });
      onLocate(place.lngLat);
    }
    send({ type: "picked", place });
  };

  const search = locate.search;
  const query = search.kind === "open" ? search.query : siteName;
  const rowLabel =
    locate.located.kind === "locating"
      ? t(`Locating ${locate.located.query}…`, `${locate.located.query} を検索中…`)
      : siteName.trim()
        ? siteName.trim()
        : t("Find the building", "建物を検索");
  const pending = search.kind === "open" && search.outcome.kind === "pending";
  const searchDisabled = pending || !query.trim();

  return (
    <div className="shrink-0 text-sm">
      <button
        type="button"
        className="flex h-6 w-full items-center gap-1 truncate rounded-[var(--radius-md)] px-1 text-left text-xs hover:bg-[var(--color-surface-muted)]"
        aria-expanded={search.kind === "open"}
        onClick={() =>
          send(search.kind === "open" ? { type: "close" } : { type: "open", siteName })
        }
      >
        <span className="truncate">{rowLabel}</span>
        {locate.located.kind === "guessed" ? (
          <span className="shrink-0 text-[var(--color-text-muted)]">
            {t("first match", "最初の候補")}
          </span>
        ) : null}
      </button>
      {search.kind === "open" ? (
        <div
          role="region"
          aria-label={t("Find the building", "建物を検索")}
          className="mt-1"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            send({ type: "close" });
          }}
        >
          <div className="flex gap-2">
            <input
              className={FIELD}
              value={search.query}
              onChange={(event) => send({ type: "editQuery", query: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") runSearch(query);
              }}
              placeholder={t("e.g. 新宿駅", "例: 新宿駅")}
            />
            <Button size="sm" onClick={() => runSearch(query)} disabled={searchDisabled}>
              {pending ? t("Searching...", "検索中...") : t("Search", "検索")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("Close search", "検索を閉じる")}
              onClick={() => send({ type: "close" })}
            >
              ×
            </Button>
          </div>
          {search.outcome.kind === "unavailable" ? (
            <p className="mt-1 text-xs text-[var(--color-error)]">
              {t(
                "Address search is unavailable. Pan the map to the building instead.",
                "住所検索を利用できません。地図を手動で移動してください。"
              )}
            </p>
          ) : null}
          {search.outcome.kind === "empty" ? (
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              {t("No places found.", "該当する場所がありません。")}
            </p>
          ) : null}
          {search.outcome.kind === "hits" ? (
            <ul className="mt-1">
              {search.outcome.places.map((place) => (
                <li key={`${place.lngLat[0]},${place.lngLat[1]}`}>
                  <button
                    type="button"
                    title={place.name}
                    className="w-full truncate px-2 py-1 text-left text-xs hover:bg-black/5"
                    onClick={() => pick(place)}
                  >
                    {place.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
