import { useNavigate } from "react-router-dom";

import { useAppStore } from "../../store/useAppStore";

export function SessionExpiredDialog() {
  const navigate = useNavigate();
  const message = useAppStore((state) => state.sessionExpiredMessage);
  const clearSession = useAppStore((state) => state.clearSession);

  if (!message) {
    return null;
  }

  const restart = () => {
    clearSession();
    navigate("/", { replace: true });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-md rounded border bg-white p-5 shadow-lg">
        <h2 className="text-lg font-semibold">Session Expired</h2>
        <p className="mt-2 text-sm text-slate-700">{message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white"
            onClick={restart}
          >
            Back to Upload
          </button>
        </div>
      </div>
    </div>
  );
}
