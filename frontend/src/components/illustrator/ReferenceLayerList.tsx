import { useCallback, useEffect, useRef, useState } from "react";

import { uploadReferenceLayers } from "../../api/client";
import { isBackendUnreachableError, toErrorMessage } from "../../api/errors";
import { useUiLanguage } from "../../hooks/useUiLanguage";
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
  current: ShapeMatchTarget
): ShapeMatchTarget {
  const otherFloors = floorLabels.filter((label) => label !== activeFloorLabel);
  if (current.referenceFloorLabel && otherFloors.includes(current.referenceFloorLabel)) {
    return { referenceName: "", referenceFloorLabel: current.referenceFloorLabel };
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
          if (files.length) void add(files, "append");
          event.target.value = "";
        }}
      />
      <Button
        size="sm"
        disabled={loading || !pinReady}
        onClick={() => inputRef.current?.click()}
      >
        {loading ? t("Loading...", "読み込み中...") : t("Add shapefile", "シェープファイルを追加")}
      </Button>
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
