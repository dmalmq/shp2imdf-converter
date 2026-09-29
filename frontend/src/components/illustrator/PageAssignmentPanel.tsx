import { AlertTriangle } from "lucide-react";
import { useMemo, useState } from "react";
import type { FeatureCollection } from "geojson";

import type { IllustratorPageAlignment, IllustratorPagePreview } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { buildSvgPaths, splitByPage, type PartitionFloor } from "../../lib/svgPreview";
import { NextBar } from "../bringIn/NextBar";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";
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
  alignment?: IllustratorPageAlignment[];
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
 * Floor assignment for a multi-page document: the pages on the left, the one
 * selected on the right.
 *
 * The common case — one floor plan per page — needs no drawing at all. A page
 * holding several plans gets boxes drawn on it in place, tagged with that page,
 * so a box floor and a page floor are the same record.
 */
export function PageAssignmentPanel({
  preview,
  pages,
  layerSummaries,
  onAssigned,
  onSkip,
  initialBoxesByPage,
  alignment = []
}: Props) {
  const { t, uiLanguage } = useUiLanguage();
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
  const [selected, setSelected] = useState<number | undefined>(pages[0]?.index);
  const [drawingPage, setDrawingPage] = useState<number | null>(null);

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
  const movedPages = alignment.filter((entry) => entry.aligned);
  const failedPages = alignment.filter((entry) => !entry.aligned);
  const anchor = alignment[0]?.anchor_page;
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

  const setBoxes = (index: number, boxes: PartitionFloor[]) =>
    setBoxesByPage((prev) => {
      const next = new Map(prev);
      if (boxes.length > 0) next.set(index, boxes);
      else next.delete(index);
      return next;
    });

  const selectedPage = pages.find((page) => page.index === selected) ?? pages[0];
  const selectedCard = cards.find((card) => card.index === selectedPage?.index);
  const selectedBoxes = selectedPage ? (boxesByPage.get(selectedPage.index) ?? []) : [];
  const boxing = Boolean(selectedPage) && (selectedBoxes.length > 0 || drawingPage === selectedPage.index);
  const leftOut = cards.filter((card) => card.excluded).map((card) => card.index);

  const thumbnail = (page: IllustratorPagePreview, className: string) => {
    const { viewBox, paths } = buildSvgPaths(byPage.get(page.index) ?? EMPTY_PREVIEW, page.bounds);
    const [, miny, , maxy] = page.bounds;
    return (
      <svg viewBox={viewBox} className={className} aria-hidden="true">
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
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[420px] shrink-0 flex-col gap-4 overflow-auto border-r border-border bg-card px-7 py-7">
          <div className="flex flex-col gap-1">
            <h1 className="font-display text-[26px] font-semibold leading-8 text-foreground">
              {t("Name each page", "ページに名前を付ける")}
            </h1>
            <p className="text-[13px] leading-5 text-muted-foreground">
              {t(
                "Same name, same floor. Tick a cover sheet or legend as not a floor plan to leave it out.",
                "同じ名前は同じフロアになります。表紙や凡例は「平面図ではない」にして除外してください。"
              )}
            </p>
          </div>

          {movedPages.length > 0 ? (
            <p data-testid="page-alignment-note" className="text-xs text-muted-foreground">
              {movedPages.length === 1
                ? t(
                    `Page ${movedPages[0].page} was aligned to page ${anchor} automatically.`,
                    `ページ ${movedPages[0].page} をページ ${anchor} に自動で合わせました。`
                  )
                : t(
                    `Pages ${movedPages.map((entry) => entry.page).join(", ")} were aligned to page ${anchor} automatically.`,
                    `ページ ${movedPages.map((entry) => entry.page).join("、")} をページ ${anchor} に自動で合わせました。`
                  )}
            </p>
          ) : null}

          {failedPages.length > 0 || sizesDiffer ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning bg-warning-surface p-3">
              <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-warning-foreground" />
              <div className="flex flex-col gap-1">
                {failedPages.length > 0 ? (
                  <p data-testid="page-alignment-warning" className="text-[13px] leading-[18px] text-foreground">
                    {failedPages.length === 1
                      ? t(
                          `Page ${failedPages[0].page} did not match page ${anchor}; align that floor yourself.`,
                          `ページ ${failedPages[0].page} はページ ${anchor} と一致しませんでした。該当フロアは手動で合わせてください。`
                        )
                      : t(
                          `Pages ${failedPages.map((entry) => entry.page).join(", ")} did not match page ${anchor}; align those floors yourself.`,
                          `ページ ${failedPages.map((entry) => entry.page).join("、")} はページ ${anchor} と一致しませんでした。該当フロアは手動で合わせてください。`
                        )}
                  </p>
                ) : null}
                {sizesDiffer ? (
                  <p data-testid="page-size-warning" className="text-[13px] leading-[18px] text-foreground">
                    {t(
                      "The pages are not all the same size, so their floor plans may land offset from each other. Align the building as a group first, then switch to Individual on the map to adjust any floor that needs its own position.",
                      "ページのサイズが揃っていないため、各階の位置がずれる場合があります。まずグループで建物全体を合わせてから、地図の「個別」に切り替えて位置が合わないフロアを調整してください。"
                    )}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          <ul className="flex flex-col gap-2.5" aria-label={t("Pages", "ページ")}>
            {pages.map((page) => {
              const card = cards.find((candidate) => candidate.index === page.index)!;
              const boxes = boxesByPage.get(page.index) ?? [];
              const mergeCount = labelCounts.get(card.label.trim()) ?? 0;
              const active = page.index === selectedPage?.index;
              return (
                <li
                  key={page.index}
                  data-page={page.index}
                  onClick={() => setSelected(page.index)}
                  className={cn(
                    "flex cursor-pointer gap-3 rounded-xl p-3",
                    active ? "border-[1.5px] border-artwork bg-artwork-muted/40" : "border border-border bg-background",
                    card.excluded && "opacity-60"
                  )}
                >
                  <div className="h-11 w-14 shrink-0 overflow-hidden rounded-md border border-border bg-card">
                    {thumbnail(page, "h-full w-full")}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        className="rounded-sm text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-pressed={active}
                        onClick={() => setSelected(page.index)}
                      >
                        {t(`Page ${page.index}`, `ページ ${page.index}`)}
                      </button>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {Math.round(page.width_pt)} × {Math.round(page.height_pt)} pt ·{" "}
                        {page.preview_feature_count === 1
                          ? t("1 shape", "1 図形")
                          : t(`${page.preview_feature_count} shapes`, `${page.preview_feature_count} 図形`)}
                      </span>
                    </div>
                    {boxes.length > 0 ? (
                      <p className="flex flex-wrap items-center gap-1.5 text-xs text-artwork">
                        {boxes.length === 1
                          ? t("1 floor, marked with a box:", "1 フロア（範囲で指定）：")
                          : t(`${boxes.length} floors, marked with boxes:`, `${boxes.length} フロア（範囲で指定）：`)}
                        {boxes.map((box) => (
                          <span
                            key={box.label}
                            className="rounded-full bg-artwork px-2 py-px font-mono text-[10px] text-artwork-foreground"
                          >
                            {box.label}
                          </span>
                        ))}
                      </p>
                    ) : (
                      <input
                        aria-label={t(`Floor name for page ${page.index}`, `ページ ${page.index} のフロア名`)}
                        className="w-full rounded-md border border-input bg-card px-2 py-1 text-sm"
                        value={card.label}
                        disabled={card.excluded}
                        onClick={(event) => event.stopPropagation()}
                        onFocus={() => setSelected(page.index)}
                        onChange={(event) => update(page.index, { label: event.target.value })}
                      />
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={t(`Page ${page.index} is not a floor plan`, `ページ ${page.index} は平面図ではない`)}
                          checked={card.excluded}
                          onChange={(event) => update(page.index, { excluded: event.target.checked })}
                        />
                        {card.excluded ? t("Not a floor plan · left out", "平面図ではない · 除外") : t("Not a floor plan", "平面図ではない")}
                      </label>
                      {boxes.length === 0 && mergeCount > 1 ? (
                        <span className="text-xs text-primary">
                          {mergeCount} {t("pages", "ページ")} → {card.label.trim()}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="flex flex-col gap-1 rounded-xl bg-accent p-4">
            <p className="text-sm font-semibold text-primary">
              {t(
                `${floors.length} ${floors.length === 1 ? "floor" : "floors"} from ${pages.length - leftOut.length} ${pages.length - leftOut.length === 1 ? "page" : "pages"}`,
                `${pages.length - leftOut.length} ページから ${floors.length} フロア`
              )}
            </p>
            <p className="text-[13px] leading-5 text-muted-foreground">
              {floors.map((floor) => floor.label).join(" · ")}
              {leftOut.length > 0
                ? t(
                    `. ${leftOut.length === 1 ? "Page" : "Pages"} ${leftOut.join(", ")} ${leftOut.length === 1 ? "is" : "are"} left out.`,
                    `。ページ ${leftOut.join("、")} は除外。`
                  )
                : ""}
            </p>
          </div>

          {duplicates.length > 0 ? (
            <p className="text-xs text-destructive">
              {t(
                `Two floors share the name ${duplicates.join(", ")}. Rename one.`,
                `フロア名 ${duplicates.join("、")} が重複しています。いずれかを変更してください。`
              )}
            </p>
          ) : null}
        </aside>

        {selectedPage ? (
          <main className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto px-7 py-7">
            <div className="flex flex-col gap-1">
              <h2 className="font-display text-[24px] font-semibold leading-8 text-foreground">
                {boxing
                  ? t(`Mark each floor on page ${selectedPage.index}`, `ページ ${selectedPage.index} の各フロアを囲む`)
                  : t(`Page ${selectedPage.index}`, `ページ ${selectedPage.index}`)}
              </h2>
              <p className="text-[13px] leading-5 text-muted-foreground">
                {boxing
                  ? t(
                      "Drag a box around each floor plan. A shape joins a box when its centre is inside.",
                      "各階の平面図をドラッグで囲んでください。中心が範囲内にある図形がそのフロアになります。"
                    )
                  : t(
                      "One floor per page is the usual case. If this page holds more than one plan, mark each with a box.",
                      "通常は1ページ1フロアです。1ページに複数の平面図がある場合は、それぞれを範囲で囲んでください。"
                    )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {boxing ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setBoxes(selectedPage.index, []);
                    setDrawingPage(null);
                  }}
                >
                  {t("Remove boxes", "範囲を削除")}
                </Button>
              ) : (
                <Button
                  className="bg-artwork text-artwork-foreground hover:bg-artwork/90"
                  disabled={selectedCard?.excluded}
                  onClick={() => setDrawingPage(selectedPage.index)}
                >
                  {t("Draw boxes on this page", "このページに範囲を描く")}
                </Button>
              )}
            </div>
            {boxing ? (
              <AssignmentPanel
                key={selectedPage.index}
                embedded
                preview={byPage.get(selectedPage.index) ?? EMPTY_PREVIEW}
                artworkBounds={selectedPage.bounds}
                layerSummaries={layerSummaries}
                page={selectedPage.index}
                initialDrafts={selectedBoxes}
                onChange={(boxes) => setBoxes(selectedPage.index, boxes)}
                onAssigned={() => {}}
                onSkip={() => {}}
              />
            ) : (
              <div
                className={cn(
                  "overflow-hidden rounded-xl border border-border bg-card p-4",
                  selectedCard?.excluded && "opacity-60"
                )}
              >
                {thumbnail(selectedPage, "h-[56vh] min-h-[360px] w-full")}
              </div>
            )}
            <p className={cn("text-[11px] text-muted-foreground", uiLanguage !== "ja" && "font-mono")}>
              {t(
                "Boxes are checked again from the full drawing when you export.",
                "範囲は書き出し時に元の図面でもう一度確かめます。"
              )}
            </p>
          </main>
        ) : null}
      </div>

      <NextBar
        step={{
          title:
            floors.length > 0
              ? {
                  en: `Done assigning: ${floors.length} ${floors.length === 1 ? "floor" : "floors"} — ${floors.map((f) => f.label).join(", ")}`,
                  ja: `割り当て完了：${floors.length} フロア — ${floors.map((f) => f.label).join("、")}`
                }
              : { en: "No floors yet", ja: "フロアがまだありません" },
          detail: {
            en: "One floor per page, or per box. You can come back and change this.",
            ja: "1ページまたは1範囲ごとに1フロア。後から戻って変更できます。"
          },
          action: { en: "Done assigning", ja: "割り当て完了" },
          blocked:
            floors.length === 0
              ? { en: "Name at least one page as a floor", ja: "少なくとも1ページにフロア名を付けてください" }
              : duplicates.length > 0
                ? { en: "Two floors share a name", ja: "フロア名が重複しています" }
                : null
        }}
        secondary={
          <Button variant="ghost" onClick={onSkip}>
            {t("Skip — one floor for everything", "スキップ — 全図形を1フロアに")}
          </Button>
        }
        onGo={() => onAssigned(floors)}
      />
    </div>
  );
}
