import { Eye, EyeOff, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { uploadReferenceLayers } from "../../api/client";
import { isBackendUnreachableError, toErrorMessage } from "../../api/errors";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { preferredArtworkMatchTarget } from "../../lib/artworkMatch";
import { Button } from "../ui/button";
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pinReady = Boolean(focusBounds);

  const add = useCallback(
    async (files: File[], mode: "append" | "replace") => {
      if (!focusBounds) return;
      const batch = mode === "replace" ? archiveRef.current : files;
      if (batch.length === 0) return;
      boundsKeyRef.current = focusBounds.join(",");
      setLoading(true);
      setError(null);
      setNotice(null);
      try {
        const loaded = await uploadReferenceLayers(batch, focusBounds);
        const taken = new Set(mode === "replace" ? [] : layers.map((layer) => layer.name));
        const added: ReferenceLayer[] = [];
        const empty: string[] = [];
        const colorBase = mode === "replace" ? 0 : layers.length;
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
        if (mode === "append") {
          archiveRef.current = [...archiveRef.current, ...files];
          for (const layer of added) omittedRef.current.delete(layer.name);
        }
        const visible =
          mode === "replace" ? added.filter((layer) => !omittedRef.current.has(layer.name)) : added;
        if (empty.length > 0) {
          setNotice(
            t(
              `Nothing was found near the station in ${empty.join(", ")}.`,
              `駅周辺では見つかりませんでした：${empty.join("、")}。`
            )
          );
        }
        if (mode === "replace") {
          onChange(visible);
        } else if (visible.length > 0) {
          onChange([...layers, ...visible]);
        }
      } catch (error) {
        setError(
          isBackendUnreachableError(error)
            ? t(
                "Could not reach the converter. The server may be down or restarting - check it is running, then try again.",
                "コンバーターに接続できません。サーバーが停止または再起動中の可能性があります。稼働状況を確認してから、もう一度お試しください。"
              )
            : toErrorMessage(
                error,
                t(
                  "Could not read that file. Select the .shp with its .dbf/.shx/.prj, a .zip of them, or a .gpkg.",
                  "読み込めませんでした。.shp と .dbf/.shx/.prj、それらの .zip、または .gpkg を選択してください。"
                )
              )
        );
      } finally {
        setLoading(false);
      }
    },
    [focusBounds, layers, onChange, t]
  );

  useEffect(() => {
    const key = focusBounds?.join(",") ?? "";
    if (boundsKeyRef.current === key) return;
    boundsKeyRef.current = key;
    if (!focusBounds || archiveRef.current.length === 0) return;
    void add(archiveRef.current, "replace");
  }, [add, focusBounds]);

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
          if (files.length) void add(files, "append");
          event.target.value = "";
        }}
      />

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
      {notice ? <p className="text-xs leading-4 text-warning">{notice}</p> : null}
    </div>
  );
}
