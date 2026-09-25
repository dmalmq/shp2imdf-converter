import { useUiLanguage } from "../../hooks/useUiLanguage";
import { featureTypeColor } from "../shared/featureColors";
import { Checkbox } from "../ui";
import { layerKeyLabel } from "./types";
import { cn } from "@/lib/utils";

type Props = {
  featureTypes: string[];
  layerVisibility: Record<string, boolean>;
  validationLoaded: boolean;
  overlayVisibility: Record<string, boolean>;
  showBasemap: boolean;
  onLayerVisibilityChange: (next: Record<string, boolean>) => void;
  onOverlayVisibilityChange: (next: Record<string, boolean>) => void;
  onShowBasemapChange: (next: boolean) => void;
};

function ToggleRow({
  label,
  checked,
  onChange,
  swatch,
  capitalize
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  swatch?: string;
  capitalize?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-sm py-1 text-[13px] leading-[18px] text-foreground">
      <Checkbox checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      {swatch ? (
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
          style={{ backgroundColor: swatch }}
        />
      ) : null}
      <span className={cn("min-w-0 flex-1 truncate", capitalize && "capitalize")}>{label}</span>
    </label>
  );
}

export function LayerTree({
  featureTypes,
  layerVisibility,
  validationLoaded,
  overlayVisibility,
  showBasemap,
  onLayerVisibilityChange,
  onOverlayVisibilityChange,
  onShowBasemapChange
}: Props) {
  const { t } = useUiLanguage();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[10px] font-medium uppercase leading-[13px] tracking-[0.06em] text-muted-foreground">
          {t("Feature layers", "フィーチャーレイヤー")}
        </span>
        {/* The swatch is the same table the map paints from, so the legend
            cannot disagree with what is on screen. */}
        <div className="flex flex-col">
          {featureTypes.map((featureType) => (
            <ToggleRow
              key={featureType}
              label={layerKeyLabel(featureType)}
              capitalize
              swatch={featureTypeColor(featureType)}
              checked={layerVisibility[featureType] ?? true}
              onChange={(next) =>
                onLayerVisibilityChange({ ...layerVisibility, [featureType]: next })
              }
            />
          ))}
        </div>
      </div>

      {validationLoaded ? (
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] font-medium uppercase leading-[13px] tracking-[0.06em] text-muted-foreground">
            {t("Validation overlays", "検証オーバーレイ")}
          </span>
          <div className="flex flex-col">
            {(
              [
                ["errors", t("Error highlights", "エラー表示")],
                ["warnings", t("Warning highlights", "警告表示")],
                ["overlaps", t("Overlap polygons", "重なりポリゴン")]
              ] as const
            ).map(([key, label]) => (
              <ToggleRow
                key={key}
                label={label}
                checked={overlayVisibility[key] ?? true}
                onChange={(next) =>
                  onOverlayVisibilityChange({ ...overlayVisibility, [key]: next })
                }
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5 border-t border-border pt-3">
        <span className="font-mono text-[10px] font-medium uppercase leading-[13px] tracking-[0.06em] text-muted-foreground">
          {t("Background", "背景")}
        </span>
        <ToggleRow
          label={t("OpenStreetMap", "OpenStreetMap")}
          checked={showBasemap}
          onChange={onShowBasemapChange}
        />
      </div>
    </div>
  );
}
