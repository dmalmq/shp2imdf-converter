import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  DEFAULT_DRAWING_SCALE,
  resolvedTransform,
  type AdjustmentMode,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { cn } from "@/lib/utils";
import { PlacementScopeNote } from "./PlacementScopeNote";

type Props = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  /** What scale and calibration act on. */
  mode: AdjustmentMode;
};

/** How the Align panel's three methods are named; `move` is rough placement by hand. */
export type AlignMethod = "move" | "points" | "shape";

/**
 * The numeric drawing scale and the pt-to-metre calibration, behind
 * "Advanced": they are how you'd bootstrap a placement without a reference,
 * not something a first-time user should meet before the map.
 */
export function ScaleAndFitPanel({ state, dispatch, mode }: Props) {
  const { t } = useUiLanguage();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [denominator, setDenominator] = useState(String(DEFAULT_DRAWING_SCALE));
  const [artworkDistance, setArtworkDistance] = useState("");
  const [realMetres, setRealMetres] = useState("");

  const activeFloor =
    state.floors.find((f) => f.label === state.activeFloorLabel) ?? state.floors[0];
  const activeTransform = activeFloor ? resolvedTransform(state, activeFloor) : null;
  const pinned = Boolean(activeFloor?.pinned);

  return (
    <div className="flex flex-col gap-4">
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-sm py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="flex flex-col gap-0.5">
            <span className="text-[13px] font-medium leading-[18px] text-foreground">
              {t("Advanced", "詳細設定")}
            </span>
            <span className="text-xs leading-4 text-muted-foreground">
              {t("Drawing scale, pt ↔ m calibration", "図面縮尺、pt ↔ m 校正")}
            </span>
          </span>
          <ChevronRight
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              advancedOpen && "rotate-90"
            )}
          />
        </CollapsibleTrigger>

        <CollapsibleContent className="flex flex-col gap-3 pt-3">
          <PlacementScopeNote state={state} mode={mode} />
          <p className="font-mono text-[11px] leading-[14px] tracking-[0.02em] text-muted-foreground">
            {(activeTransform?.metresPerPoint ?? state.frame.metresPerPoint).toFixed(6)}{" "}
            {t("m per point", "m/pt")}
          </p>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">1:</span>
            <Input
              type="number"
              className="w-24"
              aria-label={t("Drawing scale denominator", "図面縮尺の分母")}
              value={denominator}
              disabled={state.scaleLocked || pinned}
              onChange={(event) => setDenominator(event.target.value)}
            />
            <Button
              size="sm"
              className="ml-auto"
              disabled={state.scaleLocked || pinned}
              onClick={() => dispatch({ type: "setDrawingScale", denominator: Number(denominator), mode })}
            >
              {t("Apply", "適用")}
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Input
              type="number"
              className="w-20"
              placeholder="pt"
              aria-label={t("Distance on the artwork", "図面上の距離")}
              value={artworkDistance}
              disabled={state.scaleLocked || pinned}
              onChange={(event) => setArtworkDistance(event.target.value)}
            />
            <span className="text-xs text-muted-foreground">=</span>
            <Input
              type="number"
              className="w-20"
              placeholder="m"
              aria-label={t("Real-world metres", "実距離（m）")}
              value={realMetres}
              disabled={state.scaleLocked || pinned}
              onChange={(event) => setRealMetres(event.target.value)}
            />
            <Button
              size="sm"
              variant="secondary"
              className="ml-auto"
              disabled={state.scaleLocked || pinned}
              onClick={() =>
                dispatch({
                  type: "calibrateDistance",
                  artworkDistance: Number(artworkDistance),
                  realMetres: Number(realMetres),
                  mode
                })
              }
            >
              {t("Calibrate", "校正")}
            </Button>
          </div>

          {state.scaleLocked ? (
            <p className="text-xs leading-4 text-muted-foreground">
              {t(
                "Unlock the scale above to change these.",
                "変更するには上の固定を解除してください。"
              )}
            </p>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
