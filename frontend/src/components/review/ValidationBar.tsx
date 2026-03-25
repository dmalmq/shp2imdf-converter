import { useUiLanguage } from "../../hooks/useUiLanguage";
import { Button, Badge, StatusDot } from "../ui";
import type { ValidationResponse } from "../../api/client";


type Props = {
  validation: ValidationResponse | null;
  validating: boolean;
  autofixing: boolean;
  overlapResolving: boolean;
  exporting: boolean;
  loading: boolean;
  onValidate: () => void;
  onAutoFix: () => void;
  onFixOverlaps: () => void;
  onExport: () => void;
};


export function ValidationBar({
  validation,
  validating,
  autofixing,
  overlapResolving,
  exporting,
  loading,
  onValidate,
  onAutoFix,
  onFixOverlaps,
  onExport
}: Props) {
  const { t } = useUiLanguage();

  return (
    <div className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
      <div className="flex items-center gap-4 text-sm">
        {validation ? (
          <>
            <span className="flex items-center gap-1.5">
              <StatusDot status={validation.summary.error_count > 0 ? "error" : "success"} size="sm" />
              <Badge variant={validation.summary.error_count > 0 ? "error" : "success"}>
                {validation.summary.error_count} {t("errors", "エラー")}
              </Badge>
            </span>
            <span className="flex items-center gap-1.5">
              <StatusDot status={validation.summary.warning_count > 0 ? "warning" : "success"} size="sm" />
              <Badge variant={validation.summary.warning_count > 0 ? "warning" : "default"}>
                {validation.summary.warning_count} {t("warnings", "警告")}
              </Badge>
            </span>
            {validation.summary.auto_fixable_count > 0 ? (
              <Badge variant="primary">
                {validation.summary.auto_fixable_count} {t("auto-fixable", "自動修正可能")}
              </Badge>
            ) : null}
          </>
        ) : (
          <span className="text-[var(--color-text-muted)]">
            {t("Not yet validated", "未検証")}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {validation && validation.summary.overlap_count > 0 ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={onFixOverlaps}
            disabled={overlapResolving}
          >
            {overlapResolving ? t("Resolving...", "解消中...") : t("Fix Overlaps", "重なりを修正")}
          </Button>
        ) : null}
        {validation && validation.summary.auto_fixable_count > 0 ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={onAutoFix}
            disabled={autofixing}
          >
            {autofixing ? t("Fixing...", "修正中...") : t("Auto-fix", "自動修正")}
          </Button>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          onClick={onValidate}
          disabled={validating || loading}
        >
          {validating ? t("Validating...", "検証中...") : t("Validate", "検証")}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onExport}
          disabled={exporting || validating || loading}
        >
          {exporting ? t("Exporting...", "エクスポート中...") : t("Export", "エクスポート")}
        </Button>
      </div>
    </div>
  );
}
