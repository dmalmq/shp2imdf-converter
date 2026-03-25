import { useLocation, useNavigate } from "react-router-dom";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import { useAppStore } from "../../store/useAppStore";


type StepDef = {
  key: string;
  labelEn: string;
  labelJa: string;
  path: string;
};

const STEPS: StepDef[] = [
  { key: "import", labelEn: "Import", labelJa: "インポート", path: "/" },
  { key: "configure", labelEn: "Configure", labelJa: "設定", path: "/wizard" },
  { key: "review", labelEn: "Review & Export", labelJa: "レビュー & エクスポート", path: "/review" }
];


function stepStatus(
  step: StepDef,
  currentPath: string,
  hasSession: boolean
): "active" | "completed" | "pending" {
  const normalizedPath = currentPath === "" ? "/" : currentPath;

  if (normalizedPath === step.path) {
    return "active";
  }

  // Steps before current are completed (if we have a session)
  const currentIndex = STEPS.findIndex((s) => s.path === normalizedPath);
  const stepIndex = STEPS.findIndex((s) => s.key === step.key);

  if (currentIndex > stepIndex && hasSession) {
    return "completed";
  }

  return "pending";
}


export function StepIndicator() {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useUiLanguage();
  const sessionId = useAppStore((s) => s.sessionId);

  return (
    <nav className="flex items-center gap-1">
      {STEPS.map((step, index) => {
        const status = stepStatus(step, location.pathname, !!sessionId);
        const canNavigate =
          (step.path === "/" ) ||
          (step.path === "/wizard" && !!sessionId) ||
          (step.path === "/review" && !!sessionId);
        const label = t(step.labelEn, step.labelJa);

        return (
          <div key={step.key} className="flex items-center">
            {index > 0 ? (
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                className="mx-0.5 text-[var(--color-text-muted)]"
              >
                <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : null}
            <button
              type="button"
              disabled={!canNavigate}
              onClick={() => {
                if (canNavigate && location.pathname !== step.path) {
                  navigate(step.path);
                }
              }}
              className={[
                "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                status === "active"
                  ? "bg-[var(--color-primary)] text-white"
                  : status === "completed"
                    ? "bg-[var(--color-success-muted)] text-[var(--color-success)] hover:bg-[var(--color-success)]/20"
                    : "bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]",
                canNavigate && status !== "active" ? "cursor-pointer" : "",
                !canNavigate && status !== "active" ? "cursor-default opacity-60" : ""
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {status === "completed" ? (
                <span className="mr-1 inline-block">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="inline -mt-px">
                    <path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              ) : null}
              {label}
            </button>
          </div>
        );
      })}
    </nav>
  );
}
