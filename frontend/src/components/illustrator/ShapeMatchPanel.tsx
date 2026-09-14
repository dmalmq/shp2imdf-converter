import { HelpCircle, Loader2 } from "lucide-react";

import type { IllustratorShapeMatchSuggestion } from "../../api/client";
import type { AdjustmentMode, PlacementState } from "../../hooks/useIllustratorPlacement";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { DisabledHint } from "../ui/tooltip";
import { cn } from "@/lib/utils";
import { OVERLAY_COLORS } from "./overlayColors";
import type { ArtworkShapeSelection, ReferenceLayer } from "./PlacementMap";

export type ShapeMatchPanelModel = {
  referenceName: string;
  referenceFloorLabel: string;
  selecting: boolean;
  selection: ArtworkShapeSelection | null;
  matches: IllustratorShapeMatchSuggestion[];
  previewRank: number | null;
  loading: boolean;
  searched: boolean;
  error: string | null;
  onReferenceChange: (name: string) => void;
  onMatchTargetChange: (target: string) => void;
  onToggleSelection: () => void;
  sourceFloorLabel: string;
  regionStage: "source" | "target" | null;
  hasSourceRegion: boolean;
  hasTargetRegion: boolean;
  onToggleRegions: () => void;
  onFind: () => void;
  onPreview: (rank: number) => void;
  onApply: () => void;
  onClear: () => void;
  /** Stop an in-flight comparison. */
  onCancel: () => void;
};

type Props = {
  state: PlacementState;
  mode: AdjustmentMode;
  referenceLayers: ReferenceLayer[];
  model: ShapeMatchPanelModel;
};

export function matchTargetValue(referenceName: string, referenceFloorLabel: string): string {
  if (referenceFloorLabel) return `floor:${referenceFloorLabel}`;
  if (referenceName) return `layer:${referenceName}`;
  return "";
}

export function parseMatchTarget(value: string): {
  referenceName: string;
  referenceFloorLabel: string;
} {
  if (value.startsWith("floor:")) {
    return { referenceName: "", referenceFloorLabel: value.slice("floor:".length) };
  }
  if (value.startsWith("layer:")) {
    return { referenceName: value.slice("layer:".length), referenceFloorLabel: "" };
  }
  return { referenceName: "", referenceFloorLabel: "" };
}

const MONO_LABEL =
  "font-mono text-[11px] uppercase leading-[14px] tracking-[0.04em] text-muted-foreground";

export function ShapeMatchPanel({ state, mode, referenceLayers, model }: Props) {
  const { t } = useUiLanguage();
  const activeFloor =
    state.floors.find((floor) => floor.label === state.activeFloorLabel) ?? state.floors[0];
  const otherFloors = state.floors.filter((floor) => floor.label !== state.activeFloorLabel);
  const canMatch = referenceLayers.length > 0 || otherFloors.length > 0;
  const hasTarget = Boolean(model.referenceName || model.referenceFloorLabel);
  const floorTarget = Boolean(model.referenceFloorLabel);
  const groupBlocked = !floorTarget && mode === "group" && !activeFloor?.linked;
  const selectedMatch = model.matches.find((match) => match.rank === model.previewRank) ?? null;
  const selectedReference = referenceLayers.find((layer) => layer.name === model.referenceName);
  const selectedTarget = matchTargetValue(model.referenceName, model.referenceFloorLabel);
  const candidateCount = otherFloors.length + referenceLayers.length;
  const regionsReady = model.hasSourceRegion && model.hasTargetRegion;
  const canFind = Boolean(model.selection) || regionsReady;

  const chooseButton = (
    <Button
      size="sm"
      className="w-full"
      variant={model.selecting ? "default" : "outline"}
      disabled={!canMatch}
      onClick={model.onToggleSelection}
    >
      {model.selecting
        ? t("Click an outline…", "外周をクリック…")
        : model.selection
          ? t("Choose another", "選び直す")
          : t("Choose outline", "外周を選択")}
    </Button>
  );

  const findButton = (
    <Button
      size="sm"
      className="w-full"
      disabled={!canFind || !hasTarget || model.loading}
      onClick={model.onFind}
    >
      {model.loading ? t("Comparing…", "比較中…") : t("Find matches", "候補を検索")}
    </Button>
  );

  const findBlockedReason = !hasTarget
    ? t("Choose what to match against first", "先に照合対象を選択してください")
    : t("Choose an outline or two areas first", "先に外周または範囲を選択してください");

  const applyButton = (
    <Button
      className="w-full"
      disabled={!selectedMatch || groupBlocked}
      onClick={model.onApply}
    >
      {floorTarget || mode === "individual"
        ? t("Apply to this floor", "このフロアに適用")
        : t("Apply to all linked floors", "リンクした全フロアに適用")}
    </Button>
  );

  const applyBlockedReason = groupBlocked
    ? t(
        `Relink ${activeFloor?.label ?? state.activeFloorLabel} to apply to all floors`,
        `全フロアに適用するには「${activeFloor?.label ?? state.activeFloorLabel}」を再リンクしてください`
      )
    : t("Pick a candidate below first", "先に下の候補を選択してください");

  return (
    <div className="flex flex-col gap-3">
      {/* No standing explanation: the tab is already labelled "Shape match", and
          the 33-word description of how ranking works is reference material, not
          something to read every time the panel opens. */}
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="shape-match-target" className={MONO_LABEL}>
          {t("Match against", "照合対象")}
        </label>
        <div className="flex items-center gap-1">
          {model.selection ? (
            <button
              type="button"
              className="rounded-sm text-[11px] leading-4 text-muted-foreground underline transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={model.onClear}
            >
              {t("Clear", "クリア")}
            </button>
          ) : null}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={t("How shape match works", "形状マッチの仕組み")}
              >
                <HelpCircle />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 text-xs leading-4 text-muted-foreground">
              {t(
                "Choose one distinctive exterior outline — a filled shape or a stroked path. The converter will rank similar polygons in a reference shapefile or another floor; nothing moves until you apply a result.",
                "塗りつぶしまたは線で描かれた外周を1つ選択してください。参照シェープファイルまたは別フロアの似たポリゴンを順位付けします。結果を適用するまで図面は移動しません。"
              )}
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {canMatch ? (
        <select
          id="shape-match-target"
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          value={selectedTarget}
          onChange={(event) => model.onMatchTargetChange(event.target.value)}
        >
          {candidateCount > 1 ? (
            <option value="">{t("Choose a target", "対象を選択")}</option>
          ) : null}
          {otherFloors.length > 0 ? (
            <optgroup label={t("Another floor", "別のフロア")}>
              {otherFloors.map((floor) => (
                <option key={floor.label} value={`floor:${floor.label}`}>
                  {floor.label}
                </option>
              ))}
            </optgroup>
          ) : null}
          {referenceLayers.length > 0 ? (
            <optgroup label={t("Shapefile", "シェープファイル")}>
              {referenceLayers.map((layer) => (
                <option key={layer.name} value={`layer:${layer.name}`}>
                  {layer.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      ) : (
        <p className="rounded-md bg-muted p-2 text-xs leading-4 text-muted-foreground">
          {t(
            "Add a shapefile in the Reference tab, or assign more than one floor.",
            "「参照」タブでシェープファイルを追加するか、フロアを複数割り当ててください。"
          )}
        </p>
      )}

      {selectedReference?.truncated ? (
        <p className="text-[11px] leading-4 text-warning">
          {t(
            "This layer was trimmed for display, so some candidates may be absent.",
            "このレイヤーは表示用に一部省略されているため、候補が含まれない場合があります。"
          )}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        {canMatch ? (
          chooseButton
        ) : (
          <DisabledHint
            hint={t(
              "Add a reference layer or a second floor first",
              "先に参照レイヤーか2つ目のフロアを追加してください"
            )}
          >
            {chooseButton}
          </DisabledHint>
        )}
        {!canFind || !hasTarget ? (
          <DisabledHint hint={findBlockedReason}>{findButton}</DisabledHint>
        ) : (
          findButton
        )}
      </div>

      {model.loading ? (
        <div className="flex items-center justify-between gap-2 rounded-md bg-muted px-2 py-1.5">
          <span className="flex items-center gap-2 text-xs leading-4 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("Comparing outlines…", "外周を比較中…")}
          </span>
          <Button size="sm" variant="ghost" className="h-6 px-2" onClick={model.onCancel}>
            {t("Cancel", "中止")}
          </Button>
        </div>
      ) : null}

      {floorTarget ? (
        <Button
          size="sm"
          className="w-full"
          variant={model.regionStage ? "default" : "outline"}
          onClick={model.onToggleRegions}
        >
          {model.regionStage === "source"
            ? t(
                `Drag around the area on ${model.sourceFloorLabel}…`,
                `「${model.sourceFloorLabel}」で範囲をドラッグ…`
              )
            : model.regionStage === "target"
              ? t(
                  `Now drag the matching area on ${model.referenceFloorLabel}…`,
                  `次に「${model.referenceFloorLabel}」で対応する範囲をドラッグ…`
                )
              : regionsReady
                ? t("Choose areas again", "範囲を選び直す")
                : t("Match areas instead", "範囲どうしで合わせる")}
        </Button>
      ) : null}

      {floorTarget && !model.regionStage && !regionsReady && !model.selection ? (
        <p className="text-[11px] leading-4 text-muted-foreground">
          {t(
            "Use areas when only part of the two floors is the same.",
            "2つのフロアの一部だけが同じ場合は範囲で合わせます。"
          )}
        </p>
      ) : null}

      {regionsReady && !model.regionStage ? (
        <p className="flex items-center gap-1.5 text-xs leading-4">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full border border-background"
            style={{ backgroundColor: OVERLAY_COLORS.reference }}
          />
          {t(
            `Areas selected on ${model.sourceFloorLabel} and ${model.referenceFloorLabel}.`,
            `「${model.sourceFloorLabel}」と「${model.referenceFloorLabel}」の範囲を選択しました。`
          )}
        </p>
      ) : null}

      {model.selection ? (
        <p className="flex items-center gap-1.5 text-xs leading-4">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full border border-background"
            style={{ backgroundColor: OVERLAY_COLORS.artwork }}
          />
          {t(
            `Outline selected on ${model.selection.floorLabel}.`,
            `「${model.selection.floorLabel}」の外周を選択しました。`
          )}
        </p>
      ) : null}

      {model.error ? (
        <p role="alert" className="text-xs leading-4 text-destructive">
          {model.error}
        </p>
      ) : null}

      {!model.loading &&
      (model.selection || regionsReady) &&
      model.matches.length === 0 &&
      !model.error &&
      !model.searched ? (
        <p className="text-[11px] leading-4 text-muted-foreground">
          {t(
            "Find matches to rank similar reference polygons.",
            "候補を検索して、似た参照ポリゴンを順位付けします。"
          )}
        </p>
      ) : null}

      {model.searched && model.matches.length === 0 && !model.loading && !model.error ? (
        <p className="rounded-md bg-muted p-2 text-xs leading-4 text-muted-foreground">
          {regionsReady
            ? t(
                "Nothing in those two areas matched. Try areas that share a distinctive shape.",
                "選択した2つの範囲では一致しませんでした。特徴的な形が含まれる範囲を選び直してください。"
              )
            : t(
                "No comparable reference polygons were found. Choose a different outline or target.",
                "比較できる参照ポリゴンが見つかりませんでした。別の外周または対象を選択してください。"
              )}
        </p>
      ) : null}

      {model.matches.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className={MONO_LABEL}>{t("Ranked candidates", "候補の順位")}</p>
          <ol className="flex flex-col gap-1.5">
            {model.matches.map((match) => {
              const active = match.rank === model.previewRank;
              return (
                <li key={`${match.reference_feature_index}:${match.reference_part_index}`}>
                  <button
                    type="button"
                    aria-pressed={active}
                    aria-label={t(
                      `Preview candidate ${match.rank}`,
                      `候補 ${match.rank} をプレビュー`
                    )}
                    className={cn(
                      "w-full rounded-md border p-2 text-left transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active ? "bg-accent" : "border-border bg-card hover:bg-accent"
                    )}
                    style={active ? { borderColor: OVERLAY_COLORS.artwork } : undefined}
                    onClick={() => model.onPreview(match.rank)}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-xs font-semibold">
                        <span
                          className="flex h-5 min-w-5 items-center justify-center rounded-full px-1 font-mono text-[10px] text-white"
                          style={{ backgroundColor: OVERLAY_COLORS.reference }}
                        >
                          {match.rank}
                        </span>
                        {t(`Candidate ${match.rank}`, `候補 ${match.rank}`)}
                      </span>
                      <span className="font-mono text-[11px] font-medium">
                        {(match.overlap_iou * 100).toFixed(0)}% {t("overlap", "重なり")}
                      </span>
                    </span>
                    <span className="mt-1 grid grid-cols-2 gap-x-2 font-mono text-[11px] text-muted-foreground">
                      <span>RMSE {match.boundary_rmse_m.toFixed(2)} m</span>
                      <span>P95 {match.boundary_p95_m.toFixed(2)} m</span>
                      <span>{match.transform.rotation_deg.toFixed(1)}°</span>
                      <span>{match.transform.metres_per_point.toFixed(4)} m/pt</span>
                    </span>
                    {match.relative_gap !== null ? (
                      <span className="mt-1 block font-mono text-[10px] text-muted-foreground">
                        {(match.relative_gap * 100).toFixed(0)}%{" "}
                        {t("better than next", "次候補より良好")}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>

          {groupBlocked ? (
            <p className="text-xs leading-4 text-destructive">
              {t(
                `Relink ${activeFloor?.label ?? state.activeFloorLabel} before applying to all floors.`,
                `すべてのフロアに適用する前に「${activeFloor?.label ?? state.activeFloorLabel}」を再リンクしてください。`
              )}
            </p>
          ) : null}

          {floorTarget ? (
            <p className="text-[11px] leading-4 text-muted-foreground">
              {t(
                "This floor will unlink so the other level keeps its position.",
                "このフロアのリンクを解除し、照合先のフロアは動かさないまま適用します。"
              )}
            </p>
          ) : null}

          {!selectedMatch || groupBlocked ? (
            <DisabledHint hint={applyBlockedReason}>{applyButton}</DisabledHint>
          ) : (
            applyButton
          )}
        </div>
      ) : null}
    </div>
  );
}
