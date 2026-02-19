import { useEffect } from "react";

import { useUiLanguage } from "../../hooks/useUiLanguage";

export function LanguageToggle() {
  const { uiLanguage, setUiLanguage, t } = useUiLanguage();

  useEffect(() => {
    document.documentElement.lang = uiLanguage;
  }, [uiLanguage]);

  const nextLanguage = uiLanguage === "en" ? "ja" : "en";

  return (
    <button
      type="button"
      className="fixed right-4 top-4 z-[55] rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
      onClick={() => setUiLanguage(nextLanguage)}
      title={t("Switch UI language", "•\Ž¦Œ¾Œê‚ðØ‚è‘Ö‚¦")}
    >
      {uiLanguage === "en" ? "“ú–{Œê" : "English"}
    </button>
  );
}
