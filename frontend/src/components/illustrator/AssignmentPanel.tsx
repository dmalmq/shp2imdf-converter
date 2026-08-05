import { useMemo, useRef, useState } from "react";
import type { FeatureCollection } from "geojson";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  buildSvgPaths,
  clientToArtworkPoint,
  partitionByFloors,
  type PartitionFloor
} from "../../lib/svgPreview";
import { Button } from "../ui";

type Props = {
  preview: FeatureCollection;
  artworkBounds: [number, number, number, number];
  layerSummaries: { table: string; ai_layer: string; role: string; feature_count: number }[];
  onAssigned: (floors: PartitionFloor[]) => void;
  onSkip: () => void;
  /** When drilling into one page of a multi-page file, tag boxes with it. */
  page?: number | null;
  /** Renders a back button when set (drill-in mode). */
  onCancel?: () => void;
};

const BOX_COLORS = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#d97706", "#0891b2"];

type DraftFloor = {
  label: string;
  box: [number, number, number, number];
  layerNames: string[] | null;
  color: string;
};

/**
 * Floor assignment: draw a box around each floor plan on the artwork preview.
 *
 * Boxes may be restricted to specific layers for files where floors are
 * overlaid at the same coordinates. Membership is computed client-side here
 * for the counts shown; the server re-verifies it from full geometry at
 * export, so a box hugging a feature edge may count differently later.
 */
export function AssignmentPanel({
  preview,
  artworkBounds,
  layerSummaries,
  onAssigned,
  onSkip,
  page = null,
  onCancel
}: Props) {
  const { t } = useUiLanguage();
  const [drafts, setDrafts] = useState<DraftFloor[]>([]);
  const [drawing, setDrawing] = useState<{
    start: [number, number];
    current: [number, number];
  } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Null outside drill-in mode, so a single-page file keeps sending null pages.
  const pageTag = useMemo(() => (page == null ? null : [page]), [page]);

  const { viewBox, paths } = useMemo(
    () => buildSvgPaths(preview, artworkBounds),
    [preview, artworkBounds]
  );

  const [minx, miny, maxx, maxy] = artworkBounds;
  // Artwork coordinates are PDF points (y-up, bottom-left origin); SVG user
  // space is y-down. Flip the content group so the artwork displays right way
  // up; pointer mapping inverts the same flip (see clientToArtworkPoint).
  const flipTransform = `translate(0 ${miny + maxy}) scale(1 -1)`;
  // Visible selection origin while dragging; sized relative to the artboard so
  // it stays legible on both large (station) and small artworks.
  const markerRadius = Math.max(1, (maxx - minx) / 100);

  const toArtworkPoint = (event: React.PointerEvent<SVGSVGElement>): [number, number] => {
    const svg = svgRef.current;
    if (!svg) return [minx, maxy];
    const rect = svg.getBoundingClientRect();
    return clientToArtworkPoint(artworkBounds, rect, event.clientX, event.clientY);
  };

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    setDrawing({ start: toArtworkPoint(event), current: toArtworkPoint(event) });
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (drawing) setDrawing({ ...drawing, current: toArtworkPoint(event) });
  };
  const onPointerUp = () => {
    if (!drawing) return;
    const [x0, y0] = drawing.start;
    const [x1, y1] = drawing.current;
    const box: [number, number, number, number] = [
      Math.min(x0, x1),
      Math.min(y0, y1),
      Math.max(x0, x1),
      Math.max(y0, y1)
    ];
    if (box[2] - box[0] > 2 && box[3] - box[1] > 2) {
      setDrafts((prev) => [
        ...prev,
        {
          label: `${prev.length + 1}F`,
          box,
          layerNames: null,
          color: BOX_COLORS[prev.length % BOX_COLORS.length]
        }
      ]);
    }
    setDrawing(null);
  };

  const { perFloor, unassigned } = useMemo(
    () =>
      partitionByFloors(
        preview,
        drafts.map((d) => ({
          label: d.label,
          box: d.box,
          pages: pageTag,
          layerNames: d.layerNames
        }))
      ),
    [preview, drafts, pageTag]
  );

  const toggleLayer = (index: number, layer: string) => {
    setDrafts((prev) =>
      prev.map((draft, i) => {
        if (i !== index) return draft;
        const current = draft.layerNames ?? [];
        const next = current.includes(layer)
          ? current.filter((name) => name !== layer)
          : [...current, layer];
        return { ...draft, layerNames: next.length ? next : null };
      })
    );
  };

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-[var(--color-text-muted)]">
        {t(
          "Draw a box around each floor plan. Boxes touching artwork edges may count differently at export, which uses the full geometry.",
          "各階の平面図を囲むように四角を描いてください。端に触れる四角は、書き出し時（完全な形状で判定）と数が異なる場合があります。"
        )}
      </p>
      <div className="relative overflow-hidden rounded-[var(--radius-md)] border bg-white">
        <svg
          ref={svgRef}
          viewBox={viewBox}
          className="h-[60vh] min-h-[420px] w-full touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <g transform={flipTransform}>
            {paths.map((path, index) => (
              <path
                key={index}
                d={path.d}
                fill={path.role === "polygon" ? (path.fill ?? "#cbd5e1") : "none"}
                stroke={path.role === "line" ? (path.stroke ?? "#64748b") : "#64748b"}
                strokeWidth={path.role === "line" ? 0.5 : 0.25}
                fillOpacity={path.role === "polygon" ? 0.6 : 1}
              />
            ))}
            {drafts.map((draft) => (
              <rect
                key={draft.label}
                x={draft.box[0]}
                y={draft.box[1]}
                width={draft.box[2] - draft.box[0]}
                height={draft.box[3] - draft.box[1]}
                fill={draft.color}
                fillOpacity={0.15}
                stroke={draft.color}
                strokeWidth={1}
              />
            ))}
            {drawing ? (
              <>
                <circle
                  cx={drawing.start[0]}
                  cy={drawing.start[1]}
                  r={markerRadius}
                  fill="#2563eb"
                />
                <rect
                  x={Math.min(drawing.start[0], drawing.current[0])}
                  y={Math.min(drawing.start[1], drawing.current[1])}
                  width={Math.abs(drawing.current[0] - drawing.start[0])}
                  height={Math.abs(drawing.current[1] - drawing.start[1])}
                  fill="#2563eb"
                  fillOpacity={0.15}
                  stroke="#2563eb"
                  strokeDasharray="4 2"
                />
              </>
            ) : null}
          </g>
        </svg>
      </div>

      <div className="space-y-2">
        {drafts.map((draft, index) => (
          <div key={draft.label} className="rounded-[var(--radius-md)] border p-2">
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full" style={{ background: draft.color }} />
              <input
                className="w-24 rounded-[var(--radius-md)] border px-2 py-1"
                value={draft.label}
                onChange={(event) =>
                  setDrafts((prev) =>
                    prev.map((d, i) => (i === index ? { ...d, label: event.target.value } : d))
                  )
                }
              />
              <span className="text-xs text-[var(--color-text-muted)]">
                {t("features", "図形")}: {perFloor.get(draft.label)?.length ?? 0}
              </span>
              <button
                type="button"
                className="ml-auto text-[var(--color-error)]"
                onClick={() => setDrafts((prev) => prev.filter((_, i) => i !== index))}
              >
                {t("Remove", "削除")}
              </button>
            </div>
            <details className="mt-1">
              <summary className="cursor-pointer text-xs">
                {t("Restrict to layers", "レイヤーを指定")}
              </summary>
              <div className="mt-1 flex flex-wrap gap-1">
                {layerSummaries.map((layer) => {
                  const active = draft.layerNames?.includes(layer.ai_layer) ?? false;
                  return (
                    <button
                      key={layer.ai_layer}
                      type="button"
                      onClick={() => toggleLayer(index, layer.ai_layer)}
                      className={`rounded-full border px-2 py-0.5 text-xs ${
                        active ? "bg-blue-100 border-blue-400" : "border-slate-300"
                      }`}
                    >
                      {layer.ai_layer} ({layer.feature_count})
                    </button>
                  );
                })}
              </div>
            </details>
          </div>
        ))}
      </div>

      <p className="text-xs">
        {t(
          `Unassigned: ${unassigned.length} of ${preview.features.length} preview shapes.`,
          `未割当: プレビュー ${preview.features.length} 図形中 ${unassigned.length} 件。`
        )}
      </p>

      <div className="flex gap-2">
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            {t("Back to pages", "ページ一覧へ戻る")}
          </Button>
        ) : (
          <Button variant="secondary" onClick={onSkip}>
            {t("Skip — one floor for everything", "スキップ — 全図形を1フロアに")}
          </Button>
        )}
        <Button
          className="ml-auto"
          disabled={drafts.length === 0}
          onClick={() =>
            onAssigned(
              drafts.map((d) => ({
                label: d.label,
                box: d.box,
                pages: pageTag,
                layerNames: d.layerNames
              }))
            )
          }
        >
          {t("Done assigning", "割り当て完了")}
        </Button>
      </div>
    </div>
  );
}
