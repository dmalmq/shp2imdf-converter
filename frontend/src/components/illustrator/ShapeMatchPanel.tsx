import type { IllustratorShapeMatchSuggestion } from "../../api/client";
import type { AdjustmentMode, PlacementState } from "../../hooks/useIllustratorPlacement";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { Button, Select } from "../ui";
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
  onFind: () => void;
  onPreview: (rank: number) => void;
  onApply: () => void;
  onClear: () => void;
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

  return (
    <section className="border-t border-[var(--color-border)] pt-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold">{t("Shape match", "形状で合わせる")}</h3>
          <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
            {t("Alternative to control points", "基準点を使わない方法")}
          </p>
        </div>
        {model.selection ? (
          <button
            type="button"
            className="text-[11px] text-[var(--color-text-muted)] underline"
            onClick={model.onClear}
          >
            {t("Clear", "クリア")}
          </button>
        ) : null}
      </div>

      <p className="mt-2 text-xs text-[var(--color-text-muted)]">
        {t(
          "Choose one distinctive exterior outline — a filled shape or a stroked path. The converter will rank similar polygons in a reference shapefile or another floor; nothing moves until you apply a result.",
          "塗りつぶしまたは線で描かれた外周を1つ選択してください。参照シェープファイルまたは別フロアの似たポリゴンを順位付けします。結果を適用するまで図面は移動しません。"
        )}
      </p>

      {canMatch ? (
        <Select
          label={t("Match against", "照合対象")}
          className="mt-2 h-8 text-xs"
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
        </Select>
      ) : (
        <p className="mt-2 rounded-[var(--radius-sm)] bg-[var(--color-surface-muted)] p-2 text-xs">
          {t(
            "Add a shapefile in the Reference tab, or assign more than one floor.",
            "「参照」タブでシェープファイルを追加するか、フロアを複数割り当ててください。"
          )}
        </p>
      )}

      {selectedReference?.truncated ? (
        <p className="mt-1 text-[11px] text-[var(--color-warning)]">
          {t(
            "This layer was trimmed for display, so some candidates may be absent.",
            "このレイヤーは表示用に一部省略されているため、候補が含まれない場合があります。"
          )}
        </p>
      ) : null}

      <div className="mt-2 grid grid-cols-2 gap-2">
        <Button
          size="sm"
          variant={model.selecting ? "primary" : "secondary"}
          disabled={!canMatch}
          onClick={model.onToggleSelection}
        >
          {model.selecting
            ? t("Click an outline…", "外周をクリック…")
            : model.selection
              ? t("Choose another", "選び直す")
              : t("Choose outline", "外周を選択")}
        </Button>
        <Button
          size="sm"
          disabled={!model.selection || !hasTarget || model.loading}
          onClick={model.onFind}
        >
          {model.loading ? t("Comparing…", "比較中…") : t("Find matches", "候補を検索")}
        </Button>
      </div>

      {model.selection ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs">
          <span className="h-2.5 w-2.5 rounded-full border border-white bg-[#2563eb] shadow" />
          {t(
            `Outline selected on ${model.selection.floorLabel}.`,
            `「${model.selection.floorLabel}」の外周を選択しました。`
          )}
        </p>
      ) : null}

      {model.error ? <p className="mt-2 text-xs text-[var(--color-error)]">{model.error}</p> : null}

      {!model.loading &&
      model.selection &&
      model.matches.length === 0 &&
      !model.error &&
      !model.searched ? (
        <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
          {t(
            "Find matches to rank similar reference polygons.",
            "候補を検索して、似た参照ポリゴンを順位付けします。"
          )}
        </p>
      ) : null}

      {model.searched && model.matches.length === 0 && !model.loading && !model.error ? (
        <p className="mt-2 rounded-[var(--radius-sm)] bg-[var(--color-surface-muted)] p-2 text-xs">
          {t(
            "No comparable reference polygons were found. Choose a different outline or target.",
            "比較できる参照ポリゴンが見つかりませんでした。別の外周または対象を選択してください。"
          )}
        </p>
      ) : null}

      {model.matches.length > 0 ? (
        <div className="mt-3 space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
            {t("Ranked candidates", "候補の順位")}
          </p>
          <ol className="space-y-1.5">
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
                    className={`w-full rounded-[var(--radius-md)] border p-2 text-left transition-colors ${
                      active
                        ? "border-[#2563eb] bg-blue-50"
                        : "border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-muted)]"
                    }`}
                    onClick={() => model.onPreview(match.rank)}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-xs font-semibold">
                        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[#f59e0b] px-1 text-[10px] text-white">
                          {match.rank}
                        </span>
                        {t(`Candidate ${match.rank}`, `候補 ${match.rank}`)}
                      </span>
                      <span className="text-[11px] font-medium">
                        {(match.overlap_iou * 100).toFixed(0)}% {t("overlap", "重なり")}
                      </span>
                    </span>
                    <span className="mt-1 grid grid-cols-2 gap-x-2 text-[11px] text-[var(--color-text-muted)]">
                      <span>RMSE {match.boundary_rmse_m.toFixed(2)} m</span>
                      <span>P95 {match.boundary_p95_m.toFixed(2)} m</span>
                      <span>{match.transform.rotation_deg.toFixed(1)}°</span>
                      <span>{match.transform.metres_per_point.toFixed(4)} m/pt</span>
                    </span>
                    {match.relative_gap !== null ? (
                      <span className="mt-1 block text-[10px] text-[var(--color-text-muted)]">
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
            <p className="text-xs text-[var(--color-error)]">
              {t(
                `Relink ${activeFloor?.label ?? state.activeFloorLabel} before applying to all floors.`,
                `すべてのフロアに適用する前に「${activeFloor?.label ?? state.activeFloorLabel}」を再リンクしてください。`
              )}
            </p>
          ) : null}

          {floorTarget ? (
            <p className="text-[11px] text-[var(--color-text-muted)]">
              {t(
                "This floor will unlink so the other level keeps its position.",
                "このフロアのリンクを解除し、照合先のフロアは動かさないまま適用します。"
              )}
            </p>
          ) : null}

          <Button
            size="sm"
            className="w-full"
            disabled={!selectedMatch || groupBlocked}
            onClick={model.onApply}
          >
            {floorTarget || mode === "individual"
              ? t("Apply to this floor", "このフロアに適用")
              : t("Apply to all linked floors", "リンクした全フロアに適用")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
