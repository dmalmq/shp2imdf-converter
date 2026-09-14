import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import type { ExportFormatsPayload } from "../../api/client";
import type { PlacementAction, PlacementState } from "../../hooks/useIllustratorPlacement";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Metric } from "../ui/metric";
import { SectionHeader } from "../ui/section-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../ui/select";
import { Separator } from "../ui/separator";
import { DisabledHint } from "../ui/tooltip";
import { cn } from "@/lib/utils";
import { PlacementLibrary } from "./PlacementLibrary";

type Props = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  artworkBounds: [number, number, number, number];
  crsChoices: { value: string; label: string }[];
  outputCrs: string;
  onOutputCrsChange: (value: string) => void;
  formats: ExportFormatsPayload;
  onFormatsChange: (formats: ExportFormatsPayload) => void;
  onExport: () => void;
  previewFeatures: number;
  totalFeatures: number;
  error: string | null;
};

type FormatKey = keyof ExportFormatsPayload;

/** Emitting the georeferenced files. */
export function ExportPanel({
  state,
  dispatch,
  artworkBounds,
  crsChoices,
  outputCrs,
  onOutputCrsChange,
  formats,
  onFormatsChange,
  onExport,
  previewFeatures,
  totalFeatures,
  error
}: Props) {
  const { t } = useUiLanguage();
  const [libraryOpen, setLibraryOpen] = useState(false);

  const floorCount = state.floors.length;

  const FORMATS: { key: FormatKey; label: string; note: string }[] = [
    {
      key: "shapefile",
      label: t("Shapefile", "シェープファイル"),
      note: t(
        `ONE SET PER FLOOR · ${floorCount} ${floorCount === 1 ? "SET" : "SETS"}`,
        `フロアごとに1セット · ${floorCount} セット`
      )
    },
    {
      key: "geopackage",
      label: t("GeoPackage", "GeoPackage"),
      note: t("SINGLE .GPKG, ALL FLOORS", "単一の .gpkg、全フロア")
    },
    {
      key: "qgis",
      label: t("QGIS project", "QGIS プロジェクト"),
      note: t("OPENS THE OUTPUT, CRS PRESET", "出力を開く、CRS 設定済み")
    }
  ];

  const chosen = FORMATS.filter((f) => formats[f.key]).length;
  const suggested = crsChoices[0];
  const usingSuggested = outputCrs === suggested?.value;

  const exportButton = (
    <Button className="w-full" disabled={chosen === 0} onClick={onExport}>
      {t(
        `Export ${floorCount} ${floorCount === 1 ? "floor" : "floors"}`,
        `${floorCount} フロアを書き出し`
      )}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* ── Output formats ──
          Only shapefile is on by default: this route's entire job is Illustrator
          → shapefiles, and defaulting all three silently produced three artifacts. */}
      <div className="flex flex-col gap-2">
        <SectionHeader title={t("Output", "出力")} />
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {FORMATS.map((format, index) => (
            <label
              key={format.key}
              htmlFor={`export-format-${format.key}`}
              className={cn(
                "flex cursor-pointer items-center gap-2 px-3 py-2",
                index > 0 && "border-t border-border"
              )}
            >
              <Checkbox
                id={`export-format-${format.key}`}
                checked={formats[format.key]}
                onCheckedChange={(checked) =>
                  onFormatsChange({ ...formats, [format.key]: checked === true })
                }
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span
                  className={cn(
                    "text-[13px] font-medium leading-[18px]",
                    formats[format.key] ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {format.label}
                </span>
                <span className="font-mono text-[10px] uppercase leading-[13px] tracking-[0.04em] text-muted-foreground">
                  {format.note}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* ── Coordinate system ──
          The default is derived from where the artwork sits, so say that rather
          than presenting it as a decision the user has to make. */}
      <div className="flex flex-col gap-2">
        <SectionHeader title={t("Coordinate system", "座標系")} />
        <Select value={outputCrs} onValueChange={onOutputCrsChange}>
          <SelectTrigger aria-label={t("Output CRS", "出力座標系")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {crsChoices.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="font-mono text-[10px] uppercase leading-[13px] tracking-[0.04em] text-muted-foreground">
          {usingSuggested
            ? t("DERIVED FROM MAP POSITION", "地図上の位置から判定")
            : t("MANUAL OVERRIDE", "手動で指定")}
        </p>
      </div>

      <Separator />

      <div className="flex gap-2">
        <Metric
          label={t("FEATURES", "図形")}
          value={previewFeatures === totalFeatures ? totalFeatures : `${previewFeatures} / ${totalFeatures}`}
          className="flex-1"
        />
        <Metric label={t("FLOORS", "フロア")} value={floorCount} className="flex-1" />
        <Metric label={t("FORMATS", "形式")} value={chosen} className="flex-1" />
      </div>

      {chosen === 0 ? (
        <DisabledHint hint={t("Choose at least one output format", "出力形式を1つ以上選択してください")}>
          {exportButton}
        </DisabledHint>
      ) : (
        exportButton
      )}

      {error ? (
        <p role="alert" className="text-[13px] leading-[18px] text-destructive">
          {error}
        </p>
      ) : null}

      {/* ── Saved placements ──
          Demoted below the export action rather than sitting above it. It cannot
          move to the upload screen: applying a saved placement needs an open
          conversion to dispatch against. */}
      <Collapsible open={libraryOpen} onOpenChange={setLibraryOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-sm py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="text-[13px] font-medium leading-[18px] text-foreground">
            {t("Saved placements", "保存した配置")}
          </span>
          <ChevronRight
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              libraryOpen && "rotate-90"
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <PlacementLibrary state={state} dispatch={dispatch} artworkBounds={artworkBounds} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
