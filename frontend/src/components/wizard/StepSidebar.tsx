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
  return (
    <aside className="w-full rounded border bg-white p-4 lg:w-72">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">Wizard Steps</h2>
        <button
          type="button"
          className="text-xs text-blue-700 underline underline-offset-2"
          onClick={onSkipToSummary}
        >
          Skip to Summary
        </button>
      </div>
      <ol className="space-y-2">
        {steps.map((step) => {
          const isActive = currentStep === step.id;
          const enabled = step.enabled !== false;
          return (
            <li key={step.id}>
              <button
                type="button"
                disabled={!enabled}
                onClick={() => onSelectStep(step.id)}
                className={`w-full rounded px-3 py-2 text-left text-sm transition ${
                  isActive
                    ? "bg-blue-600 text-white"
                    : enabled
                      ? "bg-slate-100 text-slate-800 hover:bg-slate-200"
                      : "cursor-not-allowed bg-slate-100 text-slate-400"
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

