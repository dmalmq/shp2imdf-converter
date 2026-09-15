import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchPreloadedReferenceLayers,
  getPreloadedReferenceOverlay,
  uploadReferenceLayers,
  type PreloadedReferenceOverlayInfo,
  type ReferenceLayerItem
} from "../../api/client";
import { isBackendUnreachableError, toErrorMessage } from "../../api/errors";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { preferredArtworkMatchTarget } from "../../lib/artworkMatch";
import { Button } from "../ui";
import type { ReferenceLayer } from "./PlacementMap";

type Props = {
  layers: ReferenceLayer[];
  onChange: (layers: ReferenceLayer[]) => void;
  /** Layer used for shape matching; owned by the placement page. */
  matchTargetName: string;
  onMatchTargetChange: (name: string) => void;
  focusBounds?: [number, number, number, number] | null;
};

export const REFERENCE_TINTS = ["#0f766e", "#b45309", "#7e22ce", "#be123c", "#1d4ed8"];

const SURVEY_POLYGON_STEM = "Station_pg";
const SURVEY_LINE_STEM = "Station_pl";
const PIN_REQUERY_MS = 300;

function layerHasStem(name: string, stem: string): boolean {
  return name === stem || name.startsWith(`${stem} `);
}

export function surveyLayerName(layers: readonly { name: string }[]): string {
  return layers.find((layer) => layerHasStem(layer.name, SURVEY_POLYGON_STEM))?.name ?? "";
}

export function preferSurveyLayer(
  layers: readonly { name: string }[],
  current: string
): string {
  if (layers.some((layer) => layer.name === current)) return current;
  const survey = surveyLayerName(layers);
  if (survey) return survey;
  const candidates = layers.filter((layer) => !layerHasStem(layer.name, SURVEY_LINE_STEM));
  return candidates.length === 1 ? candidates[0].name : "";
}

export type ShapeMatchTarget = {
  referenceName: string;
  referenceFloorLabel: string;
};

export function nextMatchTarget(
  layers: readonly { name: string }[],
  floorLabels: readonly string[],
  activeFloorLabel: string | null,
  current: ShapeMatchTarget,
  artworkMatchLabels: readonly string[] = []
): ShapeMatchTarget {
  const otherFloors = floorLabels.filter((label) => label !== activeFloorLabel);
  if (current.referenceFloorLabel && otherFloors.includes(current.referenceFloorLabel)) {
    return { referenceName: "", referenceFloorLabel: current.referenceFloorLabel };
  }
  if (activeFloorLabel && artworkMatchLabels.includes(activeFloorLabel)) {
    const target = preferredArtworkMatchTarget(
      activeFloorLabel,
      floorLabels.map((label) => ({
        label,
        artworkMatch: artworkMatchLabels.includes(label)
      }))
    );
    if (target) return { referenceName: "", referenceFloorLabel: target };
  }
  const referenceName = preferSurveyLayer(layers, current.referenceName);
  if (referenceName) {
    return { referenceName, referenceFloorLabel: "" };
  }
  if (otherFloors.length === 1) {
    return { referenceName: "", referenceFloorLabel: otherFloors[0] };
  }
  return { referenceName: "", referenceFloorLabel: "" };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function mapLoadedLayers(
  loaded: ReferenceLayerItem[],
  colorBase: number,
  taken: Set<string>
): { added: ReferenceLayer[]; empty: string[] } {
  const added: ReferenceLayer[] = [];
  const empty: string[] = [];
  for (const layer of loaded) {
    const kept = layer.geojson.features.length;
    if (kept === 0) {
      empty.push(layer.name);
      continue;
    }
    let name = layer.name;
    for (let n = 2; taken.has(name); n += 1) name = `${layer.name} (${n})`;
    taken.add(name);
    added.push({
      name,
      data: layer.geojson,
      color: REFERENCE_TINTS[(colorBase + added.length) % REFERENCE_TINTS.length],
      visible: true,
      featureCount: layer.feature_count,
      truncated: layer.truncated
    });
  }
  return { added, empty };
}

/**
 * Existing survey/GIS data drawn under the artwork to align against.
 *
 * Layers live only in this session: they are a visual reference and never
 * take part in an export.
 */
export function ReferenceLayerList({
  layers,
  onChange,
  matchTargetName,
  onMatchTargetChange,
  focusBounds
}: Props) {
  const { t } = useUiLanguage();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const archiveRef = useRef<File[]>([]);
  const omittedRef = useRef<Set<string>>(new Set());
  const boundsKeyRef = useRef(focusBounds?.join(",") ?? "");
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const preloadedActiveRef = useRef(false);
  const includeLinesRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preloadInfo, setPreloadInfo] = useState<PreloadedReferenceOverlayInfo>({
    available: false,
    label: "駅データ"
  });
  const [preloadedActive, setPreloadedActive] = useState(false);
  const [includeLines, setIncludeLines] = useState(false);
  const pinReady = Boolean(focusBounds);

  useEffect(() => {
    let cancelled = false;
    void getPreloadedReferenceOverlay()
      .then((info) => {
        if (cancelled) return;
        setPreloadInfo((current) =>
          current.available === info.available && current.label === info.label ? current : info
        );
      })
      .catch(() => {
        /* Stay on the unavailable default so a dead backend does not flash a button. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(
    async (mode: "append" | "replace", extraFiles: File[] = []): Promise<"ok" | "abort" | "error"> => {
      if (!focusBounds) return "error";
      if (mode === "replace") boundsKeyRef.current = focusBounds.join(",");
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);
      setNotice(null);
      const emptyNotice = (empty: string[]) => {
        if (empty.length === 0) return;
        setNotice(
          t(
            `Nothing was found near the station in ${empty.join(", ")}.`,
            `駅周辺では見つかりませんでした：${empty.join("、")}。`
          )
        );
      };
      try {
        if (mode === "append") {
          if (extraFiles.length === 0) return "ok";
          const loaded = await uploadReferenceLayers(extraFiles, focusBounds, controller.signal);
          const taken = new Set(layersRef.current.map((layer) => layer.name));
          const { added, empty } = mapLoadedLayers(loaded, layersRef.current.length, taken);
          archiveRef.current = [...archiveRef.current, ...extraFiles];
          for (const layer of added) omittedRef.current.delete(layer.name);
          emptyNotice(empty);
          if (added.length > 0) onChange([...layersRef.current, ...added]);
          return "ok";
        }
        const parts: ReferenceLayer[] = [];
        const taken = new Set<string>();
        const empty: string[] = [];
        if (preloadedActiveRef.current) {
          const loaded = await fetchPreloadedReferenceLayers(
            focusBounds,
            includeLinesRef.current,
            controller.signal
          );
          const mapped = mapLoadedLayers(loaded, parts.length, taken);
          parts.push(...mapped.added);
          empty.push(...mapped.empty);
        }
        if (archiveRef.current.length > 0) {
          const loaded = await uploadReferenceLayers(
            archiveRef.current,
            focusBounds,
            controller.signal
          );
          const mapped = mapLoadedLayers(loaded, parts.length, taken);
          parts.push(...mapped.added);
          empty.push(...mapped.empty);
        }
        emptyNotice(empty);
        onChange(parts.filter((layer) => !omittedRef.current.has(layer.name)));
        return "ok";
      } catch (caught) {
        if (isAbortError(caught) || controller.signal.aborted) return "abort";
        setError(
          isBackendUnreachableError(caught)
            ? t(
                "Could not reach the converter. The server may be down or restarting - check it is running, then try again.",
                "コンバーターに接続できません。サーバーが停止または再起動中の可能性があります。稼働状況を確認してから、もう一度お試しください。"
              )
            : toErrorMessage(
                caught,
                t(
                  "Could not read that file. Select the .shp with its .dbf/.shx/.prj, a .zip of them, or a .gpkg.",
                  "読み込めませんでした。.shp と .dbf/.shx/.prj、それらの .zip、または .gpkg を選択してください。"
                )
              )
        );
        return "error";
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [focusBounds, onChange, t]
  );

  useEffect(() => {
    const key = focusBounds?.join(",") ?? "";
    if (boundsKeyRef.current === key) return;
    boundsKeyRef.current = key;
    if (!focusBounds || (!preloadedActiveRef.current && archiveRef.current.length === 0)) {
      return;
    }
    abortRef.current?.abort();
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void refresh("replace");
    }, PIN_REQUERY_MS);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [focusBounds, refresh]);

  const loadPreloaded = () => {
    const wasActive = preloadedActiveRef.current;
    preloadedActiveRef.current = true;
    setPreloadedActive(true);
    void refresh("replace").then((result) => {
      if (result === "error" && !wasActive) {
        preloadedActiveRef.current = false;
        setPreloadedActive(false);
      }
    });
  };

  return (
    <div className="space-y-2 text-sm">
      <span className="text-xs font-medium">{t("Reference layers", "参照レイヤー")}</span>
      <p className="text-xs text-[var(--color-text-muted)]">
        {pinReady
          ? t(
              "Existing shapefiles drawn under the artwork to align against. Layers are trimmed to about 1 km around the station pin. Not exported.",
              "既存のシェープファイルを図面の下に表示して位置合わせに使います。駅ピン周辺約1kmに絞り込んで表示します。書き出しには含まれません。"
            )
          : t(
              "Identify the station before adding 駅データ. The overlay is trimmed to about 1 km around that pin.",
              "駅データを追加する前に駅を特定してください。オーバーレイはそのピン周辺約1kmに絞り込まれます。"
            )}
      </p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".zip,.shp,.shx,.dbf,.prj,.cpg,.gpkg"
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length) void refresh("append", files);
          event.target.value = "";
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        {preloadInfo.available ? (
          preloadedActive ? (
            <label className="inline-flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                data-testid="include-survey-lines"
                checked={includeLines}
                disabled={loading || !pinReady}
                onChange={(event) => {
                  includeLinesRef.current = event.target.checked;
                  setIncludeLines(event.target.checked);
                  void refresh("replace");
                }}
              />
              {t("Show survey lines", "線路を表示")}
            </label>
          ) : (
            <Button
              size="sm"
              data-testid="load-eki-data"
              disabled={loading || !pinReady}
              onClick={loadPreloaded}
            >
              {loading ? t("Loading...", "読み込み中...") : t("Load 駅データ", "駅データを読み込む")}
            </Button>
          )
        ) : null}
        <Button
          size="sm"
          disabled={loading || !pinReady}
          onClick={() => inputRef.current?.click()}
        >
          {loading ? t("Loading...", "読み込み中...") : t("Add shapefile", "シェープファイルを追加")}
        </Button>
      </div>
      {error ? <p className="text-xs text-[var(--color-error)]">{error}</p> : null}
      {notice ? <p className="text-xs text-[var(--color-warning)]">{notice}</p> : null}

      {layers.length > 0 ? (
        <p className="text-[11px] text-[var(--color-text-muted)]">
          {t(
            "The selected layer is used for shape matching.",
            "選択したレイヤーを形状合わせに使います。"
          )}
        </p>
      ) : null}
      <ul
        className="space-y-1"
        role={layers.length > 0 ? "radiogroup" : undefined}
        aria-label={layers.length > 0 ? t("Match target", "照合対象") : undefined}
      >
        {layers.map((layer, index) => {
          const shown = layer.data.features.length;
          const trimmed = layer.truncated ? t(", trimmed", "、一部表示") : "";
          const count =
            shown < layer.featureCount
              ? `${shown} / ${layer.featureCount}${trimmed}`
              : `${layer.featureCount}${trimmed}`;
          return (
            <li key={layer.name} className="flex items-center gap-2 text-xs">
              <input
                type="radio"
                name="shape-match-target"
                checked={layer.name === matchTargetName}
                onChange={() => onMatchTargetChange(layer.name)}
                aria-label={t(`Match with ${layer.name}`, `${layer.name} で照合`)}
              />
              <input
                type="checkbox"
                checked={layer.visible}
                onChange={(event) =>
                  onChange(
                    layers.map((item, i) =>
                      i === index ? { ...item, visible: event.target.checked } : item
                    )
                  )
                }
              />
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ background: layer.color }}
              />
              <span className="truncate" title={layer.name}>
                {layer.name}
              </span>
              <span className="text-[var(--color-text-muted)]">{count}</span>
              <button
                type="button"
                className="ml-auto text-[var(--color-error)]"
                onClick={() => {
                  omittedRef.current.add(layer.name);
                  onChange(layers.filter((_, i) => i !== index));
                }}
              >
                {t("Remove", "削除")}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
