import { Link } from "react-router-dom";

import { useAppStore } from "../store/useAppStore";


export function WizardPage() {
  const sessionId = useAppStore((state) => state.sessionId);

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-4 p-6">
      <h1 className="text-3xl font-semibold">Wizard (Phase 1 Shell)</h1>
      <p className="text-slate-600">
        This screen is intentionally minimal in Phase 1. Detection, mappings, and generation steps are
        added in later phases.
      </p>
      <div className="rounded border bg-white p-4">
        <p className="text-sm">
          Current session: <span className="font-mono">{sessionId ?? "No active session"}</span>
        </p>
      </div>
      <div className="flex gap-3">
        <Link className="rounded bg-slate-700 px-4 py-2 text-white" to="/">
          Back to Upload
        </Link>
        <Link className="rounded bg-blue-600 px-4 py-2 text-white" to="/review">
          Go to Review Shell
        </Link>
      </div>
    </main>
  );
}

