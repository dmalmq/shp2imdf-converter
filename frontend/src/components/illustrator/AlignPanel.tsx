import type { Dispatch } from "react";

import type { ReferenceSelection } from "../../api/client";
import type { AdjustmentMode, PlacementAction, PlacementState } from "../../hooks/useIllustratorPlacement";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import type { CurrentReferences, FloorStatus } from "../../lib/floorStatus";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { DisabledHint } from "../ui/tooltip";
import { ControlPointList } from "./ControlPointList";
import { LocateControl } from "./LocateControl";
import type { Located } from "./locateChrome";
import type { ReferenceLayer } from "./PlacementMap";
import { ReferenceLayerList } from "./ReferenceLayerList";
import { ScaleAndFitPanel, type AlignMethod } from "./ScaleAndFitPanel";
import { ShapeMatchPanel, type ShapeMatchPanelModel } from "./ShapeMatchPanel";
import { HistoryButtons, TransformPanel } from "./TransformPanel";

/** Which view of the placement page is open; saved with the draft. `reference` is the Move method. */
export type PlacementTab = "fit" | "reference" | "export";

export type SurveySnapModel = {
  layerName: string;
  notice: string | null;
  onSnap: () => void;
};

type Props = {
  state: PlacementState;
  dispatch: Dispatch<PlacementAction>;
  mode: AdjustmentMode;
  siteName: string;
  conversionId: string;
  onLocate: (lngLat: [number, number]) => void;
  onLookupSettled?: () => void;
  restoredLocation?: Located;
  onLocatedChange?: (located: Located) => void;
  referenceSelection?: ReferenceSelection;
  onReferenceSelectionChange?: (selection: ReferenceSelection) => void;
  canUndo: boolean;
  canRedo: boolean;
  pickStage: "artwork" | "map" | null;
  onTogglePicking: () => void;
  shapeMatch: ShapeMatchPanelModel;
  alignMethod: AlignMethod;
  onAlignMethodChange: (method: AlignMethod) => void;
  statuses: Map<string, FloorStatus>;
  references: CurrentReferences;
  surveySnap: SurveySnapModel;
  referenceLayers: ReferenceLayer[];
  onReferenceLayersChange: (layers: ReferenceLayer[]) => void;
  focusBounds?: [number, number, number, number] | null;
};


/**
 * The one floating panel that places the active floor: Move by hand, fit
 * Control points, or Shape match. All three stay mounted, since each holds
 * work in progress (a half-typed scale, a picked outline) a switch must keep.
 */
export function AlignPanel({
  state,
  dispatch,
  mode,
  siteName,
  conversionId,
  onLocate,
  onLookupSettled,
  restoredLocation,
  onLocatedChange,
  referenceSelection,
  onReferenceSelectionChange,
  canUndo,
  canRedo,
  pickStage,
  onTogglePicking,
  shapeMatch,
  alignMethod,
  onAlignMethodChange,
  statuses,
  references,
  surveySnap,
  referenceLayers,
  onReferenceLayersChange,
  focusBounds
}: Props) {
  const { t, uiLanguage } = useUiLanguage();
  // Geist Mono has no CJK, so Japanese labels stay in the sans face.
  const MONO_LABEL =
    uiLanguage === "ja"
      ? "text-[11px] font-medium leading-[14px] text-muted-foreground"
      : "font-mono text-[11px] uppercase leading-[14px] tracking-[0.04em] text-muted-foreground";
  const active = state.floors.find((floor) => floor.label === state.activeFloorLabel) ?? state.floors[0];
  const label = active?.label ?? "";
  const aligned = active ? statuses.get(active.label)?.kind === "aligned" : false;
  const linkedLabels = state.floors.filter((floor) => floor.linked && !floor.pinned).map((floor) => floor.label);
  const framePill = !active
    ? null
    : active.pinned
      ? t("Pinned", "固定")
      : active.linked && state.floors.length > 1
        ? t(`Linked · ${linkedLabels.join(" ")}`, `リンク · ${linkedLabels.join(" ")}`)
        : state.floors.length > 1
          ? t("Own frame", "個別フレーム")
          : null;

  const snapButton = (
    <DisabledHint
      hint={
        surveySnap.layerName
          ? null
          : t("Add a Station_pg reference layer to enable", "Station_pg の参照レイヤーを追加すると有効になります")
      }
    >
      <Button variant="outline" className="w-full" disabled={!surveySnap.layerName} onClick={surveySnap.onSnap}>
        {t("Snap floors to Station_pg", "フロアを Station_pg に合わせる")}
      </Button>
    </DisabledHint>
  );

  return (
    <aside
      aria-label={t(`Align ${label}`, `${label}の位置合わせ`)}
      data-testid="align-panel"
      className="absolute bottom-4 right-4 top-4 z-20 flex w-[340px] flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-lg"
    >
      <Tabs
        value={alignMethod}
        onValueChange={(value) => onAlignMethodChange(value as AlignMethod)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <header className="flex flex-col gap-3 px-5 pt-5">
          <div className="flex items-center gap-2">
            <h2 className="font-display text-[22px] font-semibold leading-7 text-foreground">
              {t(`Align ${label}`, `${label}を合わせる`)}
            </h2>
            {framePill ? (
              <span className="ml-auto truncate rounded-full bg-artwork-muted px-2 py-0.5 font-mono text-[11px] leading-4 text-artwork">
                {framePill}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <Badge variant={aligned ? "success" : "warning"}>
              {aligned ? t("Aligned", "位置合わせ済み") : t("Needs alignment", "位置合わせが必要")}
            </Badge>
            <span className="ml-auto flex gap-1">
              <HistoryButtons dispatch={dispatch} canUndo={canUndo} canRedo={canRedo} />
            </span>
          </div>
          <TabsList className="w-full">
            <TabsTrigger value="move" className="flex-1">
              {t("Move", "移動")}
            </TabsTrigger>
            <TabsTrigger value="points" className="flex-1">
              {t("Control points", "対応点")}
            </TabsTrigger>
            <TabsTrigger value="shape" className="flex-1">
              {t("Shape match", "形状マッチ")}
            </TabsTrigger>
          </TabsList>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-5 pb-5 pt-4">
          <TabsContent value="move" data-tab="move" forceMount hidden={alignMethod !== "move"}>
            <div className="flex flex-col gap-4">
              <section className="flex flex-col gap-1.5">
                <p className={MONO_LABEL}>{t("1 · Find the building", "1 · 建物を探す")}</p>
                <LocateControl
                  key={conversionId}
                  siteName={siteName}
                  dispatch={dispatch}
                  onLocate={onLocate}
                  onLookupSettled={onLookupSettled}
                  restored={restoredLocation}
                  onLocatedChange={onLocatedChange}
                />
              </section>
              <section className="flex flex-col gap-1.5">
                <p className={MONO_LABEL}>{t("2 · Reference to align against", "2 · 合わせる参照データ")}</p>
                <ReferenceLayerList
                  key={conversionId}
                  layers={referenceLayers}
                  onChange={onReferenceLayersChange}
                  matchTargetName={shapeMatch.referenceName}
                  onMatchTargetChange={shapeMatch.onReferenceChange}
                  focusBounds={focusBounds}
                  selection={referenceSelection}
                  onSelectionChange={onReferenceSelectionChange}
                />
              </section>
              <section className="flex flex-col gap-1.5">
                <p className={MONO_LABEL}>{t("3 · Put the floors roughly on", "3 · フロアをおおまかに置く")}</p>
                <p className="text-xs leading-4 text-muted-foreground">
                  {t(
                    "Close is enough. Matching pairs or a shape match take it to centimetres.",
                    "おおよそで十分です。対応点か形状マッチでセンチ単位まで合わせます。"
                  )}
                </p>
                <TransformPanel state={state} dispatch={dispatch} mode={mode} showHistory={false} references={references} />
              </section>
              <Button onClick={() => onAlignMethodChange("points")}>
                {t("Align with pairs →", "対応点で合わせる →")}
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="points" data-tab="points" forceMount hidden={alignMethod !== "points"}>
            <div className="flex flex-col gap-4">
              <ControlPointList
                state={state}
                dispatch={dispatch}
                pickStage={pickStage}
                mode={mode}
                onTogglePicking={onTogglePicking}
              />
              <ScaleAndFitPanel state={state} dispatch={dispatch} mode={mode} />
            </div>
          </TabsContent>

          <TabsContent value="shape" data-tab="shape" forceMount hidden={alignMethod !== "shape"}>
            <div className="flex flex-col gap-3">
              <ShapeMatchPanel state={state} mode={mode} referenceLayers={referenceLayers} model={shapeMatch} />
              {snapButton}
              {surveySnap.notice ? (
                <p className="text-xs leading-4 text-muted-foreground">{surveySnap.notice}</p>
              ) : null}
            </div>
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}
