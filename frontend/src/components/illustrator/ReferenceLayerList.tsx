import { useRef, useState } from "react";

import { uploadReferenceLayers } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { Button } from "../ui";
import type { ReferenceLayer } from "./PlacementMap";

type Props = {
  layers: ReferenceLayer[];
  onChange: (layers: ReferenceLayer[]) => void;
};

export const REFERENCE_TINTS = ["#0f766e", "#b45309", "#7e22ce", "#be123c", "#1d4ed8"];

/**
 * Existing survey/GIS data drawn under the artwork to align against.
 *
 * Layers live only in this session: they are a visual reference and never
 * take part in an export.
 */
export function ReferenceLayerList({ layers, onChange }: Props) {
  const { t } = useUiLanguage();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (files: File[]) => {
    setLoading(true);
    setError(null);
    try {
      const loaded = await uploadReferenceLayers(files);
      const taken = new Set(layers.map((layer) => layer.name));
      const added: ReferenceLayer[] = loaded.map((layer, index) => {
        // Same file twice is a real workflow (re-export); keep names unique.
        let name = layer.name;
        for (let n = 2; taken.has(name); n += 1) name = `${layer.name} (${n})`;
        taken.add(name);
        return {
          name,
          data: layer.geojson,
          color: REFERENCE_TINTS[(layers.length + index) % REFERENCE_TINTS.length],
          visible: true,
          featureCount: layer.feature_count,
          truncated: layer.truncated
        };
      });
      onChange([...layers, ...added]);
    } catch {
      setError(
        t(
          "Could not read that file. Select the .shp with its .dbf/.shx/.prj, a .zip of them, or a .gpkg.",
          "読み込めませんでした。.shp と .dbf/.shx/.prj、それらの .zip、または .gpkg を選択してください。"
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
        {t(
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

      <ul className="space-y-1">
        {layers.map((layer, index) => (
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
            <span className="text-[var(--color-text-muted)]">
              {layer.truncated
                ? t(`${layer.featureCount}, trimmed`, `${layer.featureCount}、一部表示`)
                : layer.featureCount}
            </span>
            <button
              type="button"
              className="ml-auto text-[var(--color-error)]"
              onClick={() => onChange(layers.filter((_, i) => i !== index))}
            >
              {t("Remove", "削除")}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
