import { useRef, useState } from "react";

import { uploadReferenceLayers } from "../../api/client";
import { isBackendUnreachableError, toErrorMessage } from "../../api/errors";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { Button } from "../ui";
import type { ReferenceLayer } from "./PlacementMap";

type Props = {
  layers: ReferenceLayer[];
  onChange: (layers: ReferenceLayer[]) => void;
  /** WGS84 box of the placed artwork; uploads are trimmed to ~1 km around it. */
  focusBounds?: [number, number, number, number] | null;
};

export const REFERENCE_TINTS = ["#0f766e", "#b45309", "#7e22ce", "#be123c", "#1d4ed8"];

/**
 * Existing survey/GIS data drawn under the artwork to align against.
 *
 * Layers live only in this session: they are a visual reference and never
 * take part in an export.
 */
export function ReferenceLayerList({ layers, onChange, focusBounds }: Props) {
  const { t } = useUiLanguage();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const add = async (files: File[]) => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const loaded = await uploadReferenceLayers(files, focusBounds);
      const taken = new Set(layers.map((layer) => layer.name));
      const added: ReferenceLayer[] = [];
      const empty: string[] = [];
      for (const layer of loaded) {
        const kept = layer.geojson.features.length;
        // A layer with nothing inside the focus box renders as an invisible
        // ghost row; say so instead of pretending the file is empty.
        if (kept === 0) {
          empty.push(layer.name);
          continue;
        }
        // Same file twice is a real workflow (re-export); keep names unique.
        let name = layer.name;
        for (let n = 2; taken.has(name); n += 1) name = `${layer.name} (${n})`;
        taken.add(name);
        added.push({
          name,
          data: layer.geojson,
          color: REFERENCE_TINTS[(layers.length + added.length) % REFERENCE_TINTS.length],
          visible: true,
          featureCount: layer.feature_count,
          truncated: layer.truncated
        });
      }
      if (empty.length > 0) {
        setNotice(
          t(
            `Nothing was found near the artwork in ${empty.join(", ")}.`,
            `アートワーク周辺では見つかりませんでした：${empty.join("、")}。`
          )
        );
      }
      if (added.length > 0) {
        onChange([...layers, ...added]);
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
  };

  return (
    <div className="space-y-2 text-sm">
      <span className="text-xs font-medium">{t("Reference layers", "参照レイヤー")}</span>
      <p className="text-xs text-[var(--color-text-muted)]">
        {focusBounds
          ? t(
              "Existing shapefiles drawn under the artwork to align against. Layers are trimmed to about 1 km around the artwork. Not exported.",
              "既存のシェープファイルを図面の下に表示して位置合わせに使います。アートワーク周辺約1kmに絞り込んで表示します。書き出しには含まれません。"
            )
          : t(
              "Existing shapefiles drawn under the artwork to align against. Not exported.",
              "既存のシェープファイルを図面の下に表示して位置合わせに使います。書き出しには含まれません。"
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
          if (files.length) void add(files);
          event.target.value = "";
        }}
      />
      <Button size="sm" disabled={loading} onClick={() => inputRef.current?.click()}>
        {loading ? t("Loading...", "読み込み中...") : t("Add shapefile", "シェープファイルを追加")}
      </Button>
      {error ? <p className="text-xs text-[var(--color-error)]">{error}</p> : null}
      {notice ? <p className="text-xs text-[var(--color-warning)]">{notice}</p> : null}

      <ul className="space-y-1">
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
                onClick={() => onChange(layers.filter((_, i) => i !== index))}
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
