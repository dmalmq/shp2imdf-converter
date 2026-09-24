import { Eye, EyeOff, X } from "lucide-react";
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
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { DisabledHint } from "../ui/tooltip";
import { cn } from "@/lib/utils";
import type { ReferenceLayer } from "./PlacementMap";

type Props = {
  layers: ReferenceLayer[];
  onChange: (layers: ReferenceLayer[]) => void;
  /** Layer used for shape matching; owned by the placement page. */
  matchTargetName: string;
  onMatchTargetChange: (name: string) => void;
  focusBounds?: [number, number, number, number] | null;
};

/**
 * Reference overlays are data, not brand: they need to be distinguishable from
 * each other and subordinate to `signal`, which is reserved for the placed
 * artwork. These mirror the `layer-1..4` tokens — they cannot be Tailwind
 * classes because MapLibre paint takes colour strings, not CSS variables.
 */
export const REFERENCE_TINTS = ["#2563eb", "#0891b2", "#65a30d", "#57534e"];

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

  const addButton = (
    <Button
      size="sm"
      variant="outline"
      disabled={loading || !pinReady}
      onClick={() => inputRef.current?.click()}
    >
      {loading ? t("Loading...", "読み込み中...") : t("Add shapefile", "シェープファイルを追加")}
    </Button>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold leading-[18px] text-foreground">
          {t("Reference layers", "参照レイヤー")}
        </h3>
        <DisabledHint
          className="w-auto"
          hint={pinReady ? null : t("Identify the station first", "先に駅を特定してください")}
        >
          {addButton}
        </DisabledHint>
      </div>

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
      {preloadInfo.available ? (
        preloadedActive ? (
          <label className="flex cursor-pointer items-center gap-2 text-[13px] leading-[18px] text-foreground">
            <Checkbox
              data-testid="include-survey-lines"
              checked={includeLines}
              disabled={loading || !pinReady}
              onCheckedChange={(checked) => {
                const next = checked === true;
                includeLinesRef.current = next;
                setIncludeLines(next);
                void refresh("replace");
              }}
            />
            <span>{t("Show survey lines", "線路を表示")}</span>
          </label>
        ) : (
          <DisabledHint
            hint={pinReady ? null : t("Identify the station first", "先に駅を特定してください")}
          >
            <Button
              size="sm"
              className="w-full"
              data-testid="load-eki-data"
              disabled={loading || !pinReady}
              onClick={loadPreloaded}
            >
              {loading
                ? t("Loading...", "読み込み中...")
                : t("Load 駅データ", "駅データを読み込む")}
            </Button>
          </DisabledHint>
        )
      ) : null}

      {!pinReady ? (
        <p className="text-xs leading-4 text-muted-foreground">
          {t(
            "Identify the station before adding 駅データ. The overlay is trimmed to about 1 km around that pin.",
            "駅データを追加する前に駅を特定してください。オーバーレイはそのピン周辺約1kmに絞り込まれます。"
          )}
        </p>
      ) : layers.length === 0 ? (
        <p className="text-xs leading-4 text-muted-foreground">
          {t(
            "Nothing added yet. A .shp with its sidecars, a .zip of them, or a .gpkg.",
            "まだ追加されていません。.shp と付随ファイル、それらの .zip、または .gpkg。"
          )}
        </p>
      ) : null}

      {layers.length > 0 ? (
        <>
          <ul
            className="overflow-hidden rounded-lg border border-border bg-card"
            role="radiogroup"
            aria-label={t("Match target", "照合対象")}
          >
            {layers.map((layer, index) => {
              const shown = layer.data.features.length;
              const trimmed = layer.truncated ? t(", trimmed", "、一部表示") : "";
              const count =
                shown < layer.featureCount
                  ? `${shown} / ${layer.featureCount}${trimmed}`
                  : `${layer.featureCount}${trimmed}`;
              return (
                <li
                  key={layer.name}
                  className={cn(
                    "flex items-start gap-2 px-2.5 py-2",
                    index > 0 && "border-t border-border"
                  )}
                >
                  {/* The radio picks the shape-match target, so it sits on the
                      row it applies to rather than in a separate control. */}
                  <input
                    type="radio"
                    name="shape-match-target"
                    className="mt-1 h-3.5 w-3.5 shrink-0 accent-foreground"
                    checked={layer.name === matchTargetName}
                    onChange={() => onMatchTargetChange(layer.name)}
                    aria-label={t(`Match with ${layer.name}`, `${layer.name} で照合`)}
                  />

                  <button
                    type="button"
                    aria-pressed={layer.visible}
                    aria-label={
                      layer.visible
                        ? t(`Hide ${layer.name}`, `${layer.name} を非表示`)
                        : t(`Show ${layer.name}`, `${layer.name} を表示`)
                    }
                    className="mt-0.5 shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() =>
                      onChange(
                        layers.map((item, i) =>
                          i === index ? { ...item, visible: !item.visible } : item
                        )
                      )
                    }
                  >
                    {layer.visible ? (
                      <Eye className="h-3.5 w-3.5" />
                    ) : (
                      <EyeOff className="h-3.5 w-3.5" />
                    )}
                  </button>

                  <span
                    aria-hidden="true"
                    className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-sm", !layer.visible && "opacity-40")}
                    style={{ backgroundColor: layer.color }}
                  />

                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span
                      className={cn(
                        "truncate text-[13px] font-medium leading-[18px]",
                        layer.visible ? "text-foreground" : "text-muted-foreground"
                      )}
                      title={layer.name}
                    >
                      {layer.name}
                    </span>
                    <span className="font-mono text-[11px] leading-[14px] tracking-[0.02em] text-muted-foreground">
                      {count}
                    </span>
                  </span>

                  <button
                    type="button"
                    aria-label={t(`Remove ${layer.name}`, `${layer.name} を削除`)}
                    className="mt-0.5 shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      omittedRef.current.add(layer.name);
                      onChange(layers.filter((_, i) => i !== index));
                    }}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Was two sentences of standing prose above the list; the constraint
              that actually matters is the trim, and it belongs with the data. */}
          <p className="font-mono text-[10px] uppercase leading-[13px] tracking-[0.04em] text-muted-foreground">
            {t(
              "Trimmed to about 1 km around the pin · not exported",
              "ピン周辺約1kmに絞り込み · 書き出し対象外"
            )}
          </p>
        </>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs leading-4 text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? <p className="text-xs leading-4 text-warning-foreground">{notice}</p> : null}
    </div>
  );
}
