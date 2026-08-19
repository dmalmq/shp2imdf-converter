import { useMemo, useState } from "react";
import type { FeatureCollection } from "geojson";

import type { IllustratorPagePreview } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { buildSvgPaths, splitByPage, type PartitionFloor } from "../../lib/svgPreview";
import { Button } from "../ui";
import { AssignmentPanel } from "./AssignmentPanel";

type Props = {
  preview: FeatureCollection;
  pages: IllustratorPagePreview[];
  layerSummaries: { table: string; ai_layer: string; role: string; feature_count: number }[];
  onAssigned: (floors: PartitionFloor[]) => void;
  onSkip: () => void;
  /**
   * Test seam: start the grid with pages that already have boxes. Omitted —
   * the only in-app call path — behaves exactly as before (empty map).
   */
  initialBoxesByPage?: Map<number, PartitionFloor[]>;
};

export type PageCard = {
  index: number;
  label: string;
  excluded: boolean;
};

const EMPTY_PREVIEW: FeatureCollection = { type: "FeatureCollection", features: [] };

/**
 * Turn the grid's state into floor records.
 *
 * A page that was split into boxes contributes those boxes (already tagged with
 * their page); every other included page contributes a whole-page floor. Pages
 * sharing a trimmed label merge into one floor — the label is the grouping key.
 */
export function buildFloors(
  cards: PageCard[],
  boxesByPage: Map<number, PartitionFloor[]>
): PartitionFloor[] {
  const boxFloors: PartitionFloor[] = [];
  const merged = new Map<string, number[]>();

  for (const card of cards) {
    if (card.excluded) continue;
    const boxes = boxesByPage.get(card.index);
    if (boxes && boxes.length > 0) {
      boxFloors.push(...boxes);
      continue;
    }
    const label = card.label.trim();
    if (!label) continue;
    const pages = merged.get(label);
    if (pages) pages.push(card.index);
    else merged.set(label, [card.index]);
  }

  return [
    ...boxFloors,
    ...[...merged.entries()].map(([label, pages]) => ({
      label,
      box: null,
      pages,
      layerNames: null
    }))
  ];
}

/** Labels claimed by more than one floor — the assign endpoint rejects these. */
export function duplicateLabels(floors: PartitionFloor[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const floor of floors) {
    if (seen.has(floor.label)) duplicates.add(floor.label);
    seen.add(floor.label);
  }
  return [...duplicates];
}

/**
 * Floor assignment for a multi-page document: one card per page.
 *
 * The common case — one floor plan per page — needs no drawing at all. A page
 * holding several plans drills into AssignmentPanel, whose boxes come back
 * tagged with that page, so a box floor and a page floor are the same record.
 */
export function PageAssignmentPanel({
  preview,
  pages,
  layerSummaries,
  onAssigned,
  onSkip,
  initialBoxesByPage
}: Props) {
  const { t } = useUiLanguage();
  const byPage = useMemo(() => splitByPage(preview), [preview]);
  const [cards, setCards] = useState<PageCard[]>(() =>
    pages.map((page, position) => ({
      index: page.index,
      label: `${position + 1}F`,
      // A blank or text-only sheet is not a floor plan.
      excluded: page.feature_count === 0
    }))
  );
  const [boxesByPage, setBoxesByPage] = useState<Map<number, PartitionFloor[]>>(
    () => initialBoxesByPage ?? new Map()
  );
  const [splitting, setSplitting] = useState<number | null>(null);

  const sizesDiffer = useMemo(
    // Compare at the displayed precision: MediaBox floats carry sub-point
    // noise (e.g. 1190.9999 vs 1191.0001) that renders as the same size.
    () =>
      new Set(pages.map((page) => `${Math.round(page.width_pt)}x${Math.round(page.height_pt)}`))
        .size > 1,
    [pages]
  );
  const floors = useMemo(() => buildFloors(cards, boxesByPage), [cards, boxesByPage]);
  const duplicates = useMemo(() => duplicateLabels(floors), [floors]);
  const labelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const card of cards) {
      if (card.excluded || boxesByPage.get(card.index)?.length) continue;
      const label = card.label.trim();
      if (!label) continue;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return counts;
  }, [cards, boxesByPage]);

  const update = (index: number, patch: Partial<PageCard>) =>
    setCards((prev) => prev.map((card) => (card.index === index ? { ...card, ...patch } : card)));

  if (splitting !== null) {
    const page = pages.find((candidate) => candidate.index === splitting);
    return (
      <AssignmentPanel
        preview={byPage.get(splitting) ?? EMPTY_PREVIEW}
        artworkBounds={page?.bounds ?? [0, 0, 100, 100]}
        layerSummaries={layerSummaries}
        page={splitting}
        initialDrafts={boxesByPage.get(splitting) ?? []}
        onCancel={() => setSplitting(null)}
        onSkip={() => setSplitting(null)}
        onAssigned={(boxes) => {
          setBoxesByPage((prev) => new Map(prev).set(splitting, boxes));
          setSplitting(null);
        }}
      />
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-[var(--color-text-muted)]">
        {t(
          "Name the floor on each page. Pages given the same name become one floor; untick a cover sheet or legend to leave it out.",
          "各ページのフロア名を入力してください。同じ名前のページは1つのフロアにまとまります。表紙や凡例はチェックを外して除外できます。"
        )}
      </p>

      {sizesDiffer ? (
        <p
          data-testid="page-size-warning"
          className="rounded-[var(--radius-md)] border border-amber-400 bg-amber-50 p-2 text-xs"
        >
          {t(
            "The pages are not all the same size, so their floor plans may land offset from each other. Position one floor on the map, then drag any floor that needs its own position.",
            "ページのサイズが揃っていないため、各階の位置がずれる場合があります。地図上で1フロアを配置し、位置が合わないフロアは個別にドラッグしてください。"
          )}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {pages.map((page) => {
          const card = cards.find((candidate) => candidate.index === page.index)!;
          const boxes = boxesByPage.get(page.index) ?? [];
          const pagePreview = byPage.get(page.index) ?? EMPTY_PREVIEW;
          const { viewBox, paths } = buildSvgPaths(pagePreview, page.bounds);
          const [, miny, , maxy] = page.bounds;
          const mergeCount = labelCounts.get(card.label.trim()) ?? 0;
          return (
            <div
              key={page.index}
              className={`rounded-[var(--radius-md)] border p-2 ${
                card.excluded ? "opacity-50" : ""
              }`}
            >
              <div className="mb-1 flex items-center justify-between text-xs text-[var(--color-text-muted)]">
                <span>
                  {t("Page", "ページ")} {page.index}
                </span>
                <span>
                  {Math.round(page.width_pt)} × {Math.round(page.height_pt)} pt
                </span>
              </div>

              <div className="overflow-hidden rounded-[var(--radius-md)] border bg-white">
                <svg viewBox={viewBox} className="h-32 w-full">
                  {/* Artwork points are y-up; SVG user space is y-down. */}
                  <g transform={`translate(0 ${miny + maxy}) scale(1 -1)`}>
                    {paths.map((path, position) => (
                      <path
                        key={position}
                        d={path.d}
                        fill={path.role === "polygon" ? (path.fill ?? "#cbd5e1") : "none"}
                        stroke={path.role === "line" ? (path.stroke ?? "#64748b") : "#64748b"}
                        strokeWidth={path.role === "line" ? 0.5 : 0.25}
                        fillOpacity={path.role === "polygon" ? 0.6 : 1}
                      />
                    ))}
                  </g>
                </svg>
              </div>

              <label className="mt-2 flex items-center gap-2">
                <span className="sr-only">
                  {t(`Floor name for page ${page.index}`, `ページ ${page.index} のフロア名`)}
                </span>
                <input
                  aria-label={t(
                    `Floor name for page ${page.index}`,
                    `ページ ${page.index} のフロア名`
                  )}
                  className="w-24 rounded-[var(--radius-md)] border px-2 py-1"
                  value={card.label}
                  disabled={card.excluded || boxes.length > 0}
                  onChange={(event) => update(page.index, { label: event.target.value })}
                />
                <span className="text-xs text-[var(--color-text-muted)]">
                  {t("shapes", "図形")}: {page.preview_feature_count}
                </span>
              </label>

              {boxes.length > 0 ? (
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {t(`${boxes.length} boxes on this page`, `このページに ${boxes.length} 個の範囲`)}
                </p>
              ) : mergeCount > 1 ? (
                <p className="mt-1 text-xs text-blue-700">
                  {mergeCount} {t("pages", "ページ")} → {card.label.trim()}
                </p>
              ) : null}

              <div className="mt-2 flex items-center justify-between">
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    aria-label={t(
                      `Page ${page.index} is not a floor plan`,
                      `ページ ${page.index} は平面図ではない`
                    )}
                    checked={card.excluded}
                    onChange={(event) =>
                      update(page.index, { excluded: event.target.checked })
                    }
                  />
                  {t("Not a floor plan", "平面図ではない")}
                </label>
                <div className="flex items-center gap-2">
                  {boxes.length > 0 ? (
                    <button
                      type="button"
                      className="text-xs text-[var(--color-error)] underline"
                      onClick={() =>
                        setBoxesByPage((prev) => {
                          const next = new Map(prev);
                          next.delete(page.index);
                          return next;
                        })
                      }
                    >
                      {t("Remove boxes", "範囲を削除")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="text-xs underline"
                    disabled={card.excluded}
                    onClick={() => setSplitting(page.index)}
                  >
                    {boxes.length > 0
                      ? t("Edit boxes…", "範囲を編集…")
                      : t("Split this page…", "このページを分割…")}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {duplicates.length > 0 ? (
        <p className="text-xs text-[var(--color-error)]">
          {t(
            `Two floors share the name ${duplicates.join(", ")}. Rename one.`,
            `フロア名 ${duplicates.join("、")} が重複しています。いずれかを変更してください。`
          )}
        </p>
      ) : null}

      <p className="text-xs">
        {t(
          `${floors.length} floor(s) from ${pages.length} page(s).`,
          `${pages.length} ページから ${floors.length} フロア。`
        )}
      </p>

      <div className="flex gap-2">
        <Button variant="secondary" onClick={onSkip}>
          {t("Skip — one floor for everything", "スキップ — 全図形を1フロアに")}
        </Button>
        <Button
          className="ml-auto"
          disabled={floors.length === 0 || duplicates.length > 0}
          onClick={() => onAssigned(floors)}
        >
          {t("Done assigning", "割り当て完了")}
        </Button>
      </div>
    </div>
  );
}
