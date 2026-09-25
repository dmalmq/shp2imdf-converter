import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { ValidationIssue } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { areaSquareMetres, featureLabel } from "../../lib/check";
import { featureNoun, issueCopy } from "../../lib/checkCopy";
import { geometryToPath } from "../../lib/svgPreview";
import type { ReviewFeature } from "../review/types";
import { Button } from "../ui";
import { cn } from "@/lib/utils";
import type { Geometry } from "geojson";

type Props = {
  issue: ValidationIssue;
  /** 1-based number of the must-fix card, or null for an issue that can wait. */
  number: number | null;
  position: { index: number; count: number };
  featuresById: ReadonlyMap<string, ReviewFeature>;
  language: string;
  busy: boolean;
  onStep: (delta: number) => void;
  onClose: () => void;
  onKeep: (keepId: string, trimId: string) => void;
  onFixClearOverlaps: () => void;
  onSnap: (openingId: string, unitId: string) => void;
  onEdit: (featureId: string) => void;
};

/** Both shapes in one small drawing, the kept one on top. */
function OverlapSketch({ kept, trimmed }: { kept: ReviewFeature | undefined; trimmed: ReviewFeature | undefined }) {
  const shapes = [trimmed, kept].filter((feature): feature is ReviewFeature => Boolean(feature?.geometry));
  const coords: number[][] = [];
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number") coords.push(value as number[]);
    else value.forEach(collect);
  };
  shapes.forEach((feature) => collect(feature.geometry?.coordinates));
  if (coords.length === 0) return <div className="h-[54px] w-full rounded-md bg-muted" />;
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of coords) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const pad = Math.max(maxX - minX, maxY - minY) * 0.08 || 1e-6;
  const box = `${minX - pad} ${-(maxY + pad)} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;
  return (
    <svg viewBox={box} preserveAspectRatio="xMidYMid meet" className="h-[54px] w-full rounded-md bg-muted" aria-hidden="true">
      <g transform="scale(1,-1)">
        {shapes.map((feature) => (
          <path
            key={feature.id}
            d={geometryToPath(feature.geometry as Geometry)}
            vectorEffect="non-scaling-stroke"
            strokeWidth={1}
            className={feature === kept ? "fill-accent stroke-primary" : "fill-warning-surface stroke-muted-foreground"}
          />
        ))}
      </g>
    </svg>
  );
}

export function IssuePopover({
  issue,
  number,
  position,
  featuresById,
  language,
  busy,
  onStep,
  onClose,
  onKeep,
  onFixClearOverlaps,
  onSnap,
  onEdit
}: Props) {
  const { t, isJapanese } = useUiLanguage();
  const [choice, setChoice] = useState<string | null>(null);
  useEffect(() => setChoice(null), [issue]);

  const copy = issueCopy(issue.check);
  const feature = issue.feature_id ? featuresById.get(issue.feature_id) : undefined;
  const label = (target: ReviewFeature | undefined) => {
    const text = featureLabel(target, language);
    return t(text.en, text.ja);
  };
  const overlap = issue.check === "overlapping_units" && issue.feature_id && issue.related_feature_id ? issue : null;
  const snapIds = issue.check === "opening_not_touching_boundary" ? issue.snap_candidates ?? [] : [];

  let title = t(copy.title.en, copy.title.ja);
  if (overlap?.overlap_geometry) {
    const squareMetres = areaSquareMetres(overlap.overlap_geometry);
    const area = squareMetres < 0.1 ? "< 0.1" : squareMetres.toFixed(1);
    title = t(`These two spaces overlap by ${area} m²`, `2 つのスペースが ${area} m² 重なっています`);
  }

  const pair = overlap ? [overlap.feature_id!, overlap.related_feature_id!] : [];
  const letters = ["A", "B"];
  const kindOf = (target: ReviewFeature | undefined) => {
    const category = target?.properties.category;
    return typeof category === "string" && category ? category : t(featureNoun(target?.feature_type ?? "").en, featureNoun(target?.feature_type ?? "").ja);
  };

  let primary: { label: string; run: () => void } | null = null;
  if (overlap) {
    const keptIndex = choice ? pair.indexOf(choice) : -1;
    primary =
      keptIndex >= 0
        ? {
            label: t(`Keep ${letters[keptIndex]} and trim ${letters[1 - keptIndex]}`, `${letters[keptIndex]} を残して ${letters[1 - keptIndex]} を削る`),
            run: () => onKeep(pair[keptIndex], pair[1 - keptIndex])
          }
        : null;
  } else if (snapIds.length > 0) {
    primary = choice
      ? { label: t(`Snap to ${label(featuresById.get(choice))}`, `${label(featuresById.get(choice))} にスナップ`), run: () => onSnap(issue.feature_id!, choice) }
      : null;
  } else if (feature) {
    primary = { label: t("Edit this feature", "このフィーチャーを編集"), run: () => onEdit(feature.id) };
  }

  const choiceCard = (id: string, heading: string, sub: string, sketch?: React.ReactNode) => (
    <button
      key={id}
      type="button"
      aria-pressed={choice === id}
      onClick={() => setChoice(id)}
      className={cn(
        "flex min-w-0 flex-1 flex-col items-start gap-2 rounded-xl p-3 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        choice === id ? "border-2 border-primary bg-accent/50" : "border border-border hover:bg-muted/60"
      )}
    >
      {sketch}
      <span className="break-words text-[12.5px] font-semibold text-foreground">{heading}</span>
      <span className="text-[11.5px] text-muted-foreground">{sub}</span>
    </button>
  );

  return (
    <div
      role="dialog"
      aria-label={title}
      className="flex w-[400px] flex-col gap-3.5 rounded-2xl border border-input bg-popover p-5 text-popover-foreground shadow-[0_8px_14px_rgba(26,20,13,0.16)]"
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
            number === null ? "bg-warning text-card" : "bg-destructive text-destructive-foreground"
          )}
        >
          {number ?? "!"}
        </span>
        <h3 className="flex-1 text-[15px] font-semibold leading-snug">{title}</h3>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={t("Close", "閉じる")} onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {overlap ? (
        <>
          <p className="text-[13px] leading-normal text-muted-foreground">
            {t(
              "Which one should keep the shared area? The other is trimmed to fit around it.",
              "重なった部分をどちらに残しますか？もう一方はそれに合わせて削られます。"
            )}
          </p>
          <div className="flex gap-2.5">
            {pair.map((id, index) =>
              choiceCard(
                id,
                t(`Keep ${letters[index]} · ${label(featuresById.get(id))}`, `${letters[index]} を残す · ${label(featuresById.get(id))}`),
                kindOf(featuresById.get(id)),
                <OverlapSketch kept={featuresById.get(id)} trimmed={featuresById.get(pair[1 - index])} />
              )
            )}
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onFixClearOverlaps}
            className="self-start text-xs font-medium text-primary hover:underline disabled:opacity-50"
          >
            {t("Or trim every clear-cut overlap for me", "はっきりした重なりをまとめて自動で削る")}
          </button>
        </>
      ) : snapIds.length > 0 ? (
        <>
          <p className="text-[13px] leading-normal text-muted-foreground">
            {t(
              `${label(feature)} is off the wall. Which space should it snap to?`,
              `${label(feature)}が壁から離れています。どのスペースの壁にスナップしますか？`
            )}
          </p>
          <div className="flex flex-wrap gap-2.5">
            {snapIds.map((id) => choiceCard(id, label(featuresById.get(id)), kindOf(featuresById.get(id))))}
          </div>
        </>
      ) : (
        <p className="text-[13px] leading-normal text-muted-foreground">
          {feature ? label(feature) : null}
          {feature && !isJapanese ? " · " : null}
          {isJapanese ? null : issue.message}
        </p>
      )}

      <p className="rounded-[10px] bg-info-muted p-2.5 text-xs leading-[1.45] text-info">
        {t(`Why it matters: ${copy.why.en}`, `なぜ重要か：${copy.why.ja}`)}
      </p>

      <div className="flex items-center gap-2">
        {position.count > 1 ? (
          <div className="flex items-center gap-0.5">
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t("Previous", "前へ")} disabled={position.index === 0} onClick={() => onStep(-1)}>
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="font-mono text-[11px] text-muted-foreground">
              {position.index + 1} / {position.count}
            </span>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t("Next", "次へ")} disabled={position.index >= position.count - 1} onClick={() => onStep(1)}>
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => (position.index < position.count - 1 ? onStep(1) : onClose())}
          className="flex-1 whitespace-nowrap text-left text-[13px] font-medium text-muted-foreground hover:text-foreground"
        >
          {t("Skip for now", "今はスキップ")}
        </button>
        {primary ? (
          <Button size="sm" disabled={busy} onClick={primary.run}>
            {primary.label}
          </Button>
        ) : overlap || snapIds.length > 0 ? (
          <Button size="sm" disabled>
            {overlap ? t("Choose one to keep", "残す方を選択") : t("Choose a space", "スペースを選択")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
