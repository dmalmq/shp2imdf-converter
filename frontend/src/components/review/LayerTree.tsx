import { LOCATED_FEATURE_TYPES } from "./types";
import { useUiLanguage } from "../../hooks/useUiLanguage";


type Props = {
  layerVisibility: Record<string, boolean>;
  levelFilter: string;
  levelOptions: Array<{ id: string; label: string }>;
  validationLoaded: boolean;
  overlayVisibility: Record<string, boolean>;
  onLayerVisibilityChange: (next: Record<string, boolean>) => void;
  onLevelFilterChange: (next: string) => void;
  onOverlayVisibilityChange: (next: Record<string, boolean>) => void;
};


export function LayerTree({
  layerVisibility,
  levelFilter,
  levelOptions,
  validationLoaded,
  overlayVisibility,
  onLayerVisibilityChange,
  onLevelFilterChange,
  onOverlayVisibilityChange
}: Props) {
  const { t } = useUiLanguage();

  return (
    <div className="rounded border bg-white p-3">
      <h3 className="mb-2 text-sm font-semibold text-slate-700">{t("Layers", "レイヤー")}</h3>
      <div className="grid gap-1">
        {LOCATED_FEATURE_TYPES.map((featureType) => {
          const checked = layerVisibility[featureType] ?? true;
          return (
            <label key={featureType} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) =>
                  onLayerVisibilityChange({
                    ...layerVisibility,
                    [featureType]: event.target.checked
                  })
                }
              />
              <span className="capitalize">{featureType}</span>
            </label>
          );
        })}
      </div>

      <label className="mt-3 block text-sm">
        <span className="mb-1 block text-slate-600">{t("Level Filter", "レベルフィルター")}</span>
        <select
          className="w-full rounded border px-2 py-1.5"
          value={levelFilter}
          onChange={(event) => onLevelFilterChange(event.target.value)}
        >
          <option value="">{t("All Levels", "すべてのレベル")}</option>
          {levelOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {validationLoaded ? (
        <div className="mt-3 border-t pt-3">
          <h4 className="mb-2 text-sm font-medium text-slate-700">{t("Validation Overlays", "検証オーバーレイ")}</h4>
          <div className="grid gap-1">
            {[
              ["errors", t("Error highlights", "エラー表示")],
              ["warnings", t("Warning highlights", "警告表示")],
              ["overlaps", t("Overlap polygons", "重なりポリゴン")]
            ].map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={overlayVisibility[key] ?? true}
                  onChange={(event) =>
                    onOverlayVisibilityChange({
                      ...overlayVisibility,
                      [key]: event.target.checked
                    })
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
