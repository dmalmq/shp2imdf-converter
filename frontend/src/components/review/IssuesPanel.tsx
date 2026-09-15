import { useMemo } from "react";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import { type ReviewFeature, type ReviewIssue, featureName } from "./types";


type Props = {
  issues: ReviewIssue[];
  activeIndex: number | null;
  collapsed: boolean;
  feature: ReviewFeature;
  allFeatures: ReviewFeature[];
  autoFixing: boolean;
  overlapResolving: boolean;
  openingSnapping: boolean;
  onSelectIssue: (index: number | null) => void;
  onToggleCollapsed: () => void;
  onAutoFixSafe: () => void;
  onResolveUnitOverlap: (keepFeatureId: string, clipFeatureId: string) => void;
  onSnapOpening: (openingId: string, unitId: string) => void;
};


export function IssuesPanel({
  issues,
  activeIndex,
  collapsed,
  feature,
  allFeatures,
  autoFixing,
  overlapResolving,
  openingSnapping,
  onSelectIssue,
  onToggleCollapsed,
  onAutoFixSafe,
  onResolveUnitOverlap,
  onSnapOpening
}: Props) {
  const { t } = useUiLanguage();

  const errorCount = useMemo(() => issues.filter((i) => i.severity === "error").length, [issues]);
  const warningCount = useMemo(() => issues.filter((i) => i.severity === "warning").length, [issues]);

  if (issues.length === 0) {
    return null;
  }

  return (
    <div className="rounded-md border border-border bg-card">
      {/* Header */}
      <div
        className="flex cursor-pointer select-none items-center gap-2 px-3 py-2"
        onClick={onToggleCollapsed}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className={`shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
          fill="currentColor"
        >
          <path d="M3 1l4 4-4 4z" />
        </svg>
        <span className="text-xs font-medium text-foreground">
          {t("Issues", "問題")}
        </span>
        {errorCount > 0 ? (
          <span className="rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
            {errorCount}
          </span>
        ) : null}
        {warningCount > 0 ? (
          <span className="rounded-full bg-warning px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
            {warningCount}
          </span>
        ) : null}
      </div>

      {/* Issue cards */}
      {!collapsed ? (
        <div className="space-y-1.5 border-t border-border px-3 py-2">
          {issues.map((item, index) => {
            const isActive = activeIndex === index;
            return (
              <div
                key={`${item.check}-${index}`}
                className={[
                  "cursor-pointer rounded-sm border p-2 text-xs transition-colors",
                  isActive
                    ? "border-primary bg-accent"
                    : "border-border bg-card hover:bg-muted"
                ].join(" ")}
                onClick={() => onSelectIssue(isActive ? null : index)}
              >
                <p className="font-medium text-foreground">
                  <span className={item.severity === "error" ? "text-destructive" : "text-warning"}>
                    [{item.severity}]
                  </span>{" "}
                  {item.check}
                </p>
                <p className="text-muted-foreground">{item.message}</p>
                {item.fix_description ? <p className="text-warning">{item.fix_description}</p> : null}
                {item.auto_fixable ? (
                  <button
                    type="button"
                    className="mt-1 rounded border border-warning/30 px-2 py-0.5 text-[11px]"
                    onClick={(e) => { e.stopPropagation(); onAutoFixSafe(); }}
                    disabled={autoFixing}
                  >
                    {autoFixing ? t("Applying...", "適用中...") : t("Auto-fix", "自動修正")}
                  </button>
                ) : null}
                {item.check === "overlapping_units" && item.related_feature_id ? (() => {
                  const otherFeature = allFeatures.find((f) => f.id === item.related_feature_id);
                  const thisLabel = featureName(feature) || feature.id.slice(0, 8);
                  const otherLabel = otherFeature ? (featureName(otherFeature) || otherFeature.id.slice(0, 8)) : item.related_feature_id.slice(0, 8);
                  return (
                    <div className="mt-2 space-y-1.5">
                      <div className="flex flex-col gap-1 text-[11px]">
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <span className="inline-block h-3 w-3 shrink-0 rounded-sm border border-primary bg-primary/30" />
                          <span className="font-mono">{feature.id.slice(0, 8)}</span>
                          {featureName(feature) ? ` — ${featureName(feature)}` : ""}
                        </span>
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <span className="inline-block h-3 w-3 shrink-0 rounded-sm border border-warning bg-warning/30" />
                          <span className="font-mono">{(item.related_feature_id ?? "").slice(0, 8)}</span>
                          {otherFeature && featureName(otherFeature) ? ` — ${featureName(otherFeature)}` : ""}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          className="flex items-center gap-1.5 rounded border border-primary/30 bg-accent px-2 py-0.5 text-[11px] text-foreground hover:bg-accent"
                          onClick={(e) => { e.stopPropagation(); onResolveUnitOverlap(feature.id, item.related_feature_id!); }}
                          disabled={overlapResolving}
                        >
                          <span className="inline-block h-2 w-2 rounded-full bg-primary" />
                          {overlapResolving ? t("Applying...", "適用中...") : t(`Keep "${thisLabel}"`, `「${thisLabel}」を残す`)}
                        </button>
                        <button
                          type="button"
                          className="flex items-center gap-1.5 rounded border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] text-warning hover:bg-warning/20"
                          onClick={(e) => { e.stopPropagation(); onResolveUnitOverlap(item.related_feature_id!, feature.id); }}
                          disabled={overlapResolving}
                        >
                          <span className="inline-block h-2 w-2 rounded-full bg-warning" />
                          {overlapResolving ? t("Applying...", "適用中...") : t(`Keep "${otherLabel}"`, `「${otherLabel}」を残す`)}
                        </button>
                      </div>
                    </div>
                  );
                })() : null}
                {item.check === "opening_not_touching_boundary" && item.snap_candidates && item.snap_candidates.length > 0 ? (
                  <div className="mt-2 space-y-1">
                    <p className="text-[11px] text-muted-foreground">{t("Snap to nearby unit:", "近くのユニットにスナップ:")}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {item.snap_candidates.map((unitId) => {
                        const candidateFeature = allFeatures.find((f) => f.id === unitId);
                        const label = candidateFeature ? (featureName(candidateFeature) || unitId.slice(0, 8)) : unitId.slice(0, 8);
                        return (
                          <button
                            key={unitId}
                            type="button"
                            className="flex items-center gap-1.5 rounded border border-success/30 bg-success/10 px-2 py-0.5 text-[11px] text-success hover:bg-success/20 disabled:opacity-50"
                            onClick={(e) => { e.stopPropagation(); onSnapOpening(feature.id, unitId); }}
                            disabled={openingSnapping}
                          >
                            <span className="inline-block h-2 w-2 rounded-full bg-success" />
                            {openingSnapping ? t("Snapping...", "スナップ中...") : label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
