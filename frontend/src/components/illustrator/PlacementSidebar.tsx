import type { Dispatch } from "react";

import type { ExportFormatsPayload } from "../../api/client";
import type { PlacementAction, PlacementState } from "../../hooks/useIllustratorPlacement";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { Card, Tabs, tabPanelProps } from "../ui";
import { ExportPanel } from "./ExportPanel";
import type { ReferenceLayer } from "./PlacementMap";
import { ReferenceLayerList } from "./ReferenceLayerList";
import { ScaleAndFitPanel } from "./ScaleAndFitPanel";
import { TransformPanel } from "./TransformPanel";

export type PlacementTab = "fit" | "reference" | "export";

const CRS_CHOICES = (suggested: string, suggestedLabel: string) => [
  { value: suggested, label: suggestedLabel },
  { value: "EPSG:4326", label: "EPSG:4326 — WGS84 lon/lat" }
];

type Props = {
  state: PlacementState;
  dispatch: Dispatch<PlacementAction>;
  /** Building name from the drawing's file name; searched once to pre-locate. */
  siteName: string;
  /** Reports a chosen location so the map camera can follow it. */
  onLocate: (lngLat: [number, number]) => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Active tab id; the three panels stay mounted, hidden when inactive. */
  tab: PlacementTab;
  onTabChange: (tab: PlacementTab) => void;
  picking: boolean;
  onTogglePicking: () => void;
  referenceLayers: ReferenceLayer[];
  onReferenceLayersChange: (layers: ReferenceLayer[]) => void;
  /** WGS84 box of the placed artwork; reference uploads are trimmed to ~1 km. */
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

/**
 * The pinned transform card plus the tabbed card with its three panels.
 *
 * Extracted from {@link IllustratorPage} so the mounted-and-hidden invariant
 * — every panel stays mounted with the inactive ones `hidden`, preserving the
 * typed values a remount would discard — is testable without maplibre.
 */
export function PlacementSidebar({
  state,
  dispatch,
  siteName,
  onLocate,
  canUndo,
  canRedo,
  tab,
  onTabChange,
  picking,
  onTogglePicking,
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
    <div className="flex w-80 shrink-0 flex-col gap-4 overflow-hidden">
      <Card padding="md" className="shrink-0">
        <TransformPanel
          state={state}
          dispatch={dispatch}
          siteName={siteName}
          onLocate={onLocate}
          canUndo={canUndo}
          canRedo={canRedo}
        />
      </Card>

      {/* One card holds the strip and the panels — a card inside a card is
          never right. The panel area takes the remaining height and is the
          only scrolling region in this column, so no amount of content can
          push the page again. */}
      <Card padding="md" className="flex min-h-0 flex-1 flex-col">
        <Tabs
          tabs={[
            { id: "fit", label: t("Scale & fit", "縮尺と調整") },
            { id: "reference", label: t("Reference", "参照") },
            { id: "export", label: t("Export", "書き出し") }
          ]}
          active={tab}
          onChange={onTabChange}
          idPrefix="placement"
          className="shrink-0"
        />
        <div className="min-h-0 flex-1 overflow-auto pt-3">
          <div {...tabPanelProps("placement", "fit", tab === "fit")}>
            <ScaleAndFitPanel
              state={state}
              dispatch={dispatch}
              picking={picking}
              onTogglePicking={onTogglePicking}
            />
          </div>
          <div {...tabPanelProps("placement", "reference", tab === "reference")}>
            <ReferenceLayerList
              layers={referenceLayers}
              onChange={onReferenceLayersChange}
              focusBounds={focusBounds}
            />
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
