import { Link } from "react-router-dom";

import { useAppStore } from "../store/useAppStore";


export function ReviewPage() {
  const sessionId = useAppStore((state) => state.sessionId);

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-4 p-6">
      <h1 className="text-3xl font-semibold">Review (Phase 3 Placeholder)</h1>
      <p className="text-slate-600">
        Full review map/table rendering is introduced in Phase 4. In Phase 3, this page confirms summary
        confirmation and routing.
      </p>
      <div className="rounded border bg-white p-4">
        <p className="text-sm">
          Active session for future review: <span className="font-mono">{sessionId ?? "None"}</span>
        </p>
      </div>
      <Link className="w-fit rounded bg-slate-700 px-4 py-2 text-white" to="/wizard">
        Back to Wizard
      </Link>
    </main>
  );
}
