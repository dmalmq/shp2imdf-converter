import { useMemo, useRef, useState } from "react";
import type { FeatureCollection } from "geojson";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  buildSvgPaths,
  clientToArtworkPoint,
  partitionByFloors,
  type PartitionFloor
} from "../../lib/svgPreview";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DisabledHint } from "../ui/tooltip";
import { cn } from "@/lib/utils";

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
  /**
   * Boxes this page already has (re-entering "Edit boxes…" after a split).
   * Seeded into drafts on mount, coloured from BOX_COLORS by index like a
   * freshly drawn set. Omitted or empty starts from a blank canvas.
   */
  initialDrafts?: PartitionFloor[];
};

// Mirrors the `layer-1..4` tokens: draft boxes are data the operator is
// defining, so they stay cool and distinguishable, and leave the warm accent to
// the placed artwork.
const BOX_COLORS = ["#2563eb", "#0891b2", "#65a30d", "#57534e"];

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
  onCancel,
  initialDrafts
}: Props) {
  const { t } = useUiLanguage();
  const [drafts, setDrafts] = useState<DraftFloor[]>(() => {
    const seeded: DraftFloor[] = [];
    for (const floor of initialDrafts ?? []) {
      if (floor.box === null) continue; // a seeded draft always has a concrete box
      seeded.push({
        label: floor.label,
        box: floor.box,
        layerNames: floor.layerNames,
        color: BOX_COLORS[seeded.length % BOX_COLORS.length]
      });
    }
    return seeded;
  });
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

  const doneButton = (
    <Button
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
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-4 text-muted-foreground">
        {t(
          "Draw a box around each floor plan. Boxes touching artwork edges may count differently at export, which uses the full geometry.",
          "各階の平面図を囲むように四角を描いてください。端に触れる四角は、書き出し時（完全な形状で判定）と数が異なる場合があります。"
        )}
      </p>
      <div className="relative overflow-hidden rounded-lg border border-border bg-card">
        <svg
          ref={svgRef}
          viewBox={viewBox}
          className="h-[60vh] min-h-[420px] w-full cursor-crosshair touch-none"
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
                  fill="#0a0a0a"
                />
                <rect
                  x={Math.min(drawing.start[0], drawing.current[0])}
                  y={Math.min(drawing.start[1], drawing.current[1])}
                  width={Math.abs(drawing.current[0] - drawing.start[0])}
                  height={Math.abs(drawing.current[1] - drawing.start[1])}
                  fill="#0a0a0a"
                  fillOpacity={0.08}
                  stroke="#0a0a0a"
                  strokeWidth={1}
                  strokeDasharray="4 2"
                />
              </>
            ) : null}
          </g>
        </svg>

        {/* The canvas used to be a blank field with one line of grey text far
            above it. Say what the gesture is, where the gesture happens. */}
        {drafts.length === 0 && !drawing ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="rounded-md bg-foreground/80 px-3 py-1.5 text-xs font-medium leading-4 text-background">
              {t("Drag a box around a floor plan", "平面図を囲むようにドラッグ")}
            </span>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        {drafts.map((draft, index) => (
          <div key={draft.label} className="rounded-lg border border-border bg-card p-2">
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ background: draft.color }}
              />
              <Input
                className="h-8 w-24"
                aria-label={t("Floor name", "フロア名")}
                value={draft.label}
                onChange={(event) =>
                  setDrafts((prev) =>
                    prev.map((d, i) => (i === index ? { ...d, label: event.target.value } : d))
                  )
                }
              />
              <span className="text-xs leading-4 text-muted-foreground">
                {t("features", "図形")}: {perFloor.get(draft.label)?.length ?? 0}
              </span>
              <button
                type="button"
                className="ml-auto rounded-sm text-xs text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setDrafts((prev) => prev.filter((_, i) => i !== index))}
              >
                {t("Remove", "削除")}
              </button>
            </div>
            <details className="mt-1.5">
              <summary className="cursor-pointer text-xs leading-4 text-muted-foreground transition-colors hover:text-foreground">
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
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-xs transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border text-muted-foreground hover:bg-accent"
                      )}
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

      <p className="font-mono text-[11px] leading-[14px] tracking-[0.02em] text-muted-foreground">
        {t(
          `Unassigned: ${unassigned.length} of ${preview.features.length} preview shapes.`,
          `未割当: プレビュー ${preview.features.length} 図形中 ${unassigned.length} 件。`
        )}
      </p>

      <div className="flex items-center gap-2">
        {onCancel ? (
          <Button variant="outline" onClick={onCancel}>
            {t("Back to pages", "ページ一覧へ戻る")}
          </Button>
        ) : (
          <Button variant="ghost" onClick={onSkip}>
            {t("Skip — one floor for everything", "スキップ — 全図形を1フロアに")}
          </Button>
        )}
        <div className="ml-auto">
          <DisabledHint
            className="w-auto"
            hint={
              drafts.length === 0
                ? t(
                    "Draw at least one box, or skip",
                    "四角を1つ以上描くか、スキップしてください"
                  )
                : null
            }
          >
            {doneButton}
          </DisabledHint>
        </div>
      </div>
    </div>
  );
}
