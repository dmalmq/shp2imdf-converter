import { useNavigate } from "react-router-dom";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import { useAppStore } from "../../store/useAppStore";

export function SessionExpiredDialog() {
  const navigate = useNavigate();
  const { t } = useUiLanguage();
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="project-gone-title"
        aria-describedby="project-gone-body"
        className="w-full max-w-md rounded border bg-card p-5 shadow-lg"
      >
        <h2 id="project-gone-title" className="text-lg font-semibold">
          {t("This project is no longer kept on this PC", "このプロジェクトはこの PC に残っていません")}
        </h2>
        <p id="project-gone-body" className="mt-2 text-sm text-foreground">
          {t(
            "Projects are removed after a while without use, or when the PC holds too many. Bring the files in again to carry on.",
            "しばらく使われなかったプロジェクトや、保存数の上限を超えたプロジェクトは削除されます。続けるにはファイルをもう一度取り込んでください。"
          )}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
            onClick={restart}
          >
            {t("Back to projects", "プロジェクト一覧へ戻る")}
          </button>
        </div>
      </div>
    </div>
  );
}
