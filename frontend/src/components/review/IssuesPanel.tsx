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
  onSelectIssue: (index: number | null) => void;
  onToggleCollapsed: () => void;
  onAutoFixSafe: () => void;
  onResolveUnitOverlap: (keepFeatureId: string, clipFeatureId: string) => void;
};


export function IssuesPanel({
  issues,
  activeIndex,
  collapsed,
  feature,
  allFeatures,
  autoFixing,
  overlapResolving,
  onSelectIssue,
  onToggleCollapsed,
  onAutoFixSafe,
  onResolveUnitOverlap
}: Props) {
  const { t } = useUiLanguage();

  const errorCount = useMemo(() => issues.filter((i) => i.severity === "error").length, [issues]);
  const warningCount = useMemo(() => issues.filter((i) => i.severity === "warning").length, [issues]);

  if (issues.length === 0) {
    return null;
  }

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]">
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
        <span className="text-xs font-medium text-[var(--color-text)]">
          {t("Issues", "問題")}
        </span>
        {errorCount > 0 ? (
          <span className="rounded-full bg-[var(--color-error)] px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
            {errorCount}
          </span>
        ) : null}
        {warningCount > 0 ? (
          <span className="rounded-full bg-[var(--color-warning)] px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
            {warningCount}
          </span>
        ) : null}
      </div>

      {/* Issue cards */}
      {!collapsed ? (
        <div className="space-y-1.5 border-t border-[var(--color-border)] px-3 py-2">
          {issues.map((item, index) => {
            const isActive = activeIndex === index;
            return (
              <div
                key={`${item.check}-${index}`}
                className={[
                  "cursor-pointer rounded-[var(--radius-sm)] border p-2 text-xs transition-colors",
                  isActive
                    ? "border-[var(--color-primary)] bg-[var(--color-primary-muted)]"
                    : "border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-muted)]"
                ].join(" ")}
                onClick={() => onSelectIssue(isActive ? null : index)}
              >
                <p className="font-medium text-[var(--color-text)]">
                  <span className={item.severity === "error" ? "text-[var(--color-error)]" : "text-[var(--color-warning)]"}>
                    [{item.severity}]
                  </span>{" "}
                  {item.check}
                </p>
                <p className="text-[var(--color-text-muted)]">{item.message}</p>
                {item.fix_description ? <p className="text-amber-700">{item.fix_description}</p> : null}
                {item.auto_fixable ? (
                  <button
                    type="button"
                    className="mt-1 rounded border border-amber-300 px-2 py-0.5 text-[11px]"
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
                        <span className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
                          <span className="inline-block h-3 w-3 shrink-0 rounded-sm border border-blue-600 bg-blue-600/30" />
                          <span className="font-mono">{feature.id.slice(0, 8)}</span>
                          {featureName(feature) ? ` — ${featureName(feature)}` : ""}
                        </span>
                        <span className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
                          <span className="inline-block h-3 w-3 shrink-0 rounded-sm border border-orange-600 bg-orange-600/30" />
                          <span className="font-mono">{(item.related_feature_id ?? "").slice(0, 8)}</span>
                          {otherFeature && featureName(otherFeature) ? ` — ${featureName(otherFeature)}` : ""}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          className="flex items-center gap-1.5 rounded border border-blue-300 bg-blue-50 px-2 py-0.5 text-[11px] text-blue-800 hover:bg-blue-100"
                          onClick={(e) => { e.stopPropagation(); onResolveUnitOverlap(feature.id, item.related_feature_id!); }}
                          disabled={overlapResolving}
                        >
                          <span className="inline-block h-2 w-2 rounded-full bg-blue-600" />
                          {overlapResolving ? t("Applying...", "適用中...") : t(`Keep "${thisLabel}"`, `「${thisLabel}」を残す`)}
                        </button>
                        <button
                          type="button"
                          className="flex items-center gap-1.5 rounded border border-orange-300 bg-orange-50 px-2 py-0.5 text-[11px] text-orange-800 hover:bg-orange-100"
                          onClick={(e) => { e.stopPropagation(); onResolveUnitOverlap(item.related_feature_id!, feature.id); }}
                          disabled={overlapResolving}
                        >
                          <span className="inline-block h-2 w-2 rounded-full bg-orange-600" />
                          {overlapResolving ? t("Applying...", "適用中...") : t(`Keep "${otherLabel}"`, `「${otherLabel}」を残す`)}
                        </button>
                      </div>
                    </div>
                  );
                })() : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
