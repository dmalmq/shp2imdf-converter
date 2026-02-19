import { useCallback } from "react";

import { useAppStore, type UiLanguage } from "../store/useAppStore";

export function useUiLanguage() {
  const uiLanguage = useAppStore((state) => state.uiLanguage);
  const setUiLanguage = useAppStore((state) => state.setUiLanguage);

  const t = useCallback(
    (english: string, japanese: string): string => {
      return uiLanguage === "ja" ? japanese : english;
    },
    [uiLanguage]
  );

  return {
    uiLanguage,
    setUiLanguage,
    t,
    isJapanese: uiLanguage === "ja"
  } as {
    uiLanguage: UiLanguage;
    setUiLanguage: (language: UiLanguage) => void;
    t: (english: string, japanese: string) => string;
    isJapanese: boolean;
  };
}
