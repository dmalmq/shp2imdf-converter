import { useUiLanguage } from "../../hooks/useUiLanguage";

type Step = {
  id: number;
  label: string;
  enabled?: boolean;
};

type Props = {
  steps: Step[];
  currentStep: number;
  onSelectStep: (step: number) => void;
  onSkipToSummary: () => void;
};


export function StepSidebar({ steps, currentStep, onSelectStep, onSkipToSummary }: Props) {
  const { t } = useUiLanguage();

  return (
    <aside className="w-full rounded border bg-card p-5">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{t("Wizard Steps", "ウィザード手順")}</h2>
        <button
          type="button"
          className="text-xs text-primary underline underline-offset-2"
          onClick={onSkipToSummary}
        >
          {t("Skip to Summary", "概要へ移動")}
        </button>
      </div>
      <ol className="space-y-2.5">
        {steps.map((step) => {
          const isActive = currentStep === step.id;
          const enabled = step.enabled !== false;
          return (
            <li key={step.id}>
              <button
                type="button"
                disabled={!enabled}
                onClick={() => onSelectStep(step.id)}
                className={`w-full rounded px-4 py-2.5 text-left text-[0.95rem] transition ${
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : enabled
                      ? "bg-muted text-foreground hover:bg-border"
                      : "cursor-not-allowed bg-muted text-muted-foreground"
                }`}
              >
                {step.label}
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
