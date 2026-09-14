import type { Dispatch } from "react";

import type { ExportFormatsPayload } from "../../api/client";
import type { AdjustmentMode, PlacementAction, PlacementState } from "../../hooks/useIllustratorPlacement";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { Button, Card, Tabs, tabPanelProps } from "../legacy-ui";
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

  return (
    <div className="flex h-full min-h-0 w-80 shrink-0 flex-col overflow-hidden">
      <Card padding="md" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <LocateControl key={conversionId} siteName={siteName} dispatch={dispatch} onLocate={onLocate} />
        <div className="mt-2 shrink-0">
          <TransformPanel
            state={state}
            dispatch={dispatch}
            mode={mode}
            canUndo={canUndo}
            canRedo={canRedo}
          />
        </div>
        <Tabs
          tabs={[
            { id: "fit", label: t("Scale & fit", "縮尺と調整") },
            { id: "reference", label: t("Reference", "参照") },
            { id: "export", label: t("Export", "書き出し") }
          ]}
          active={tab}
          onChange={onTabChange}
          idPrefix="placement"
          className="mt-3 shrink-0"
        />
        <div className="min-h-0 flex-1 overflow-auto pt-3">
          <div {...tabPanelProps("placement", "fit", tab === "fit")}>
            <ScaleAndFitPanel
              state={state}
              dispatch={dispatch}
              pickStage={pickStage}
              mode={mode}
              onTogglePicking={onTogglePicking}
              referenceLayers={referenceLayers}
              shapeMatch={shapeMatch}
            />
          </div>
          <div {...tabPanelProps("placement", "reference", tab === "reference")}>
            <ReferenceLayerList
              key={conversionId}
              layers={referenceLayers}
              onChange={onReferenceLayersChange}
              matchTargetName={shapeMatch.referenceName}
              onMatchTargetChange={shapeMatch.onReferenceChange}
              focusBounds={focusBounds}
            />
            <div className="mt-3 space-y-1">
              <Button
                size="sm"
                variant="secondary"
                disabled={!surveySnap.layerName}
                onClick={surveySnap.onSnap}
              >
                {t("Snap to Station_pg", "Station_pg に合わせる")}
              </Button>
              {surveySnap.notice ? (
                <p className="text-xs text-[var(--color-text-muted)]">{surveySnap.notice}</p>
              ) : null}
            </div>
          </div>
          <div {...tabPanelProps("placement", "export", tab === "export")}>
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
          </div>
        </div>
      </Card>
    </div>
  );
}
