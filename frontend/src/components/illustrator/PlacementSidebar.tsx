import type { Dispatch } from "react";

import type { ExportFormatsPayload } from "../../api/client";
import type { AdjustmentMode, PlacementAction, PlacementState } from "../../hooks/useIllustratorPlacement";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { Button } from "../ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { DisabledHint } from "../ui/tooltip";
import { ExportPanel } from "./ExportPanel";
import { LocateControl } from "./LocateControl";
import type { ReferenceLayer } from "./PlacementMap";
import { ReferenceLayerList } from "./ReferenceLayerList";
import { ScaleAndFitPanel } from "./ScaleAndFitPanel";
import type { ShapeMatchPanelModel } from "./ShapeMatchPanel";
import { TransformPanel } from "./TransformPanel";

export type PlacementTab = "fit" | "reference" | "export";

export type SurveySnapModel = {
  layerName: string;
  notice: string | null;
  onSnap: () => void;
};

const CRS_CHOICES = (suggested: string, suggestedLabel: string) => [
  { value: suggested, label: suggestedLabel },
  { value: "EPSG:4326", label: "EPSG:4326 — WGS84 lon/lat" }
];

type Props = {
  state: PlacementState;
  dispatch: Dispatch<PlacementAction>;
  mode: AdjustmentMode;
  siteName: string;
  conversionId: string;
  onLocate: (lngLat: [number, number]) => void;
  canUndo: boolean;
  canRedo: boolean;
  tab: PlacementTab;
  onTabChange: (tab: PlacementTab) => void;
  pickStage: "artwork" | "map" | null;
  onTogglePicking: () => void;
  shapeMatch: ShapeMatchPanelModel;
  surveySnap: SurveySnapModel;
  referenceLayers: ReferenceLayer[];
  onReferenceLayersChange: (layers: ReferenceLayer[]) => void;
  focusBounds?: [number, number, number, number] | null;
  bounds: [number, number, number, number];
  suggestedCrs: string;
  suggestedCrsLabel: string;
  outputCrs: string;
  onOutputCrsChange: (value: string) => void;
  formats: ExportFormatsPayload;
  onFormatsChange: (formats: ExportFormatsPayload) => void;
  onExport: () => void;
  previewFeatures: number;
  totalFeatures: number;
  error: string | null;
};

export function PlacementSidebar({
  state,
  dispatch,
  mode,
  siteName,
  conversionId,
  onLocate,
  canUndo,
  canRedo,
  tab,
  onTabChange,
  pickStage,
  onTogglePicking,
  shapeMatch,
  surveySnap,
  referenceLayers,
  onReferenceLayersChange,
  focusBounds,
  bounds,
  suggestedCrs,
  suggestedCrsLabel,
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

  const snapButton = (
    <Button
      variant="secondary"
      className="w-full"
      disabled={!surveySnap.layerName}
      onClick={surveySnap.onSnap}
    >
      {t("Snap to Station_pg", "Station_pg に合わせる")}
    </Button>
  );

  return (
    <aside className="flex h-full min-h-0 w-[340px] shrink-0 flex-col border-r border-border bg-background">
      <div className="flex flex-col gap-3 px-4 pt-4">
        <LocateControl key={conversionId} siteName={siteName} dispatch={dispatch} onLocate={onLocate} />
        <TransformPanel
          state={state}
          dispatch={dispatch}
          mode={mode}
          canUndo={canUndo}
          canRedo={canRedo}
        />
      </div>

      {/* `forceMount` keeps all three panels in the DOM: each holds its own local
          state (a half-typed drawing scale, a shape-match selection) and Radix
          unmounts inactive content by default, which would throw that away on
          every tab switch. `hidden` is passed explicitly because with forceMount
          Radix considers every panel present and never sets it itself. */}
      <Tabs
        value={tab}
        onValueChange={(value) => onTabChange(value as PlacementTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="px-4 pt-3">
          <TabsList className="w-full">
            <TabsTrigger value="fit" className="flex-1">
              {t("Place", "配置")}
            </TabsTrigger>
            <TabsTrigger value="reference" className="flex-1">
              {t("Reference", "参照")}
            </TabsTrigger>
            <TabsTrigger value="export" className="flex-1">
              {t("Export", "書き出し")}
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4 pt-4">
          <TabsContent value="fit" data-tab="fit" forceMount hidden={tab !== "fit"}>
            <ScaleAndFitPanel
              state={state}
              dispatch={dispatch}
              pickStage={pickStage}
              mode={mode}
              onTogglePicking={onTogglePicking}
              referenceLayers={referenceLayers}
              shapeMatch={shapeMatch}
            />
          </TabsContent>

          <TabsContent value="reference" data-tab="reference" forceMount hidden={tab !== "reference"}>
            <div className="flex flex-col gap-3">
              <ReferenceLayerList
                key={conversionId}
                layers={referenceLayers}
                onChange={onReferenceLayersChange}
                matchTargetName={shapeMatch.referenceName}
                onMatchTargetChange={shapeMatch.onReferenceChange}
                focusBounds={focusBounds}
              />
              <div className="flex flex-col gap-1.5">
                {surveySnap.layerName ? (
                  snapButton
                ) : (
                  <DisabledHint
                    hint={t(
                      "Add a Station_pg reference layer to enable",
                      "Station_pg の参照レイヤーを追加すると有効になります"
                    )}
                  >
                    {snapButton}
                  </DisabledHint>
                )}
                {surveySnap.notice ? (
                  <p className="text-xs leading-4 text-muted-foreground">{surveySnap.notice}</p>
                ) : null}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="export" data-tab="export" forceMount hidden={tab !== "export"}>
            <ExportPanel
              state={state}
              dispatch={dispatch}
              artworkBounds={bounds}
              crsChoices={CRS_CHOICES(suggestedCrs, suggestedCrsLabel)}
              outputCrs={outputCrs}
              onOutputCrsChange={onOutputCrsChange}
              formats={formats}
              onFormatsChange={onFormatsChange}
              onExport={onExport}
              previewFeatures={previewFeatures}
              totalFeatures={totalFeatures}
              error={error}
            />
          </TabsContent>
        </div>
      </Tabs>

      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-3">
        <span className="font-mono text-[11px] leading-[14px] tracking-[0.02em] text-muted-foreground">
          {previewFeatures === totalFeatures
            ? t(`${totalFeatures} features`, `${totalFeatures} 図形`)
            : `${previewFeatures} / ${totalFeatures}`}
        </span>
        <span className="font-mono text-[11px] leading-[14px] tracking-[0.02em] text-muted-foreground">
          {outputCrs}
        </span>
      </footer>
    </aside>
  );
}
