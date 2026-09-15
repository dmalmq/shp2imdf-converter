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
      className={`fixed right-4 top-4 z-[55] rounded border border-border bg-background px-3 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-muted ${
        uiLanguage === "ja" ? "lang-ja" : ""
      }`}
      onClick={() => setUiLanguage(nextLanguage)}
      title={t("Switch UI language", "表示言語を切り替え")}
    >
      {uiLanguage === "en" ? "日本語" : "English"}
    </button>
  );
}
