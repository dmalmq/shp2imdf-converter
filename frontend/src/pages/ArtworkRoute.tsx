import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { fetchIllustratorConversion, type IllustratorConversionResponse } from "../api/client";
import { isApiClientError, toErrorMessage } from "../api/errors";
import { SkeletonBlock } from "../components/shared/SkeletonBlock";
import { artworkPath } from "../components/shell/stages";
import { Button } from "../components/ui/button";
import { useDroppedFiles } from "../hooks/useDroppedFiles";
import { useUiLanguage } from "../hooks/useUiLanguage";
import { ARTWORK_PATH } from "../lib/hub";
import { IllustratorPage } from "./IllustratorPage";

type Opening =
  | { id: string; kind: "loading" }
  | { id: string; kind: "ready"; conversion: IllustratorConversionResponse }
  | { id: string; kind: "gone" }
  | { id: string; kind: "failed"; message: string };

/**
 * `/illustrator` starts new artwork; `/a/:conversionId` reopens a stored one.
 *
 * Both paths render this component, so the page that converts a file stays
 * mounted when the URL is replaced with the conversion it created. Each page
 * instance is keyed, and every conversion id it creates maps to its key: only
 * an id no page here holds is fetched and restored.
 */
export function ArtworkRoute() {
  const { conversionId } = useParams();
  const [dropped] = useDroppedFiles();
  const navigate = useNavigate();
  const { t } = useUiLanguage();
  const holders = useRef(new Map<string, string>());
  const [fresh, setFresh] = useState({ id: conversionId, generation: 0 });
  const [opening, setOpening] = useState<Opening | null>(null);
  const [attempt, setAttempt] = useState(0);

  if (fresh.id !== conversionId) {
    setFresh({ id: conversionId, generation: fresh.generation + (conversionId ? 0 : 1) });
  }

  useEffect(() => {
    if (!conversionId || holders.current.has(conversionId)) return;
    let active = true;
    setOpening({ id: conversionId, kind: "loading" });
    fetchIllustratorConversion(conversionId).then(
      (conversion) => {
        if (!active) return;
        holders.current.set(conversionId, conversionId);
        setOpening({ id: conversionId, kind: "ready", conversion });
      },
      (error: unknown) => {
        if (!active) return;
        setOpening(
          isApiClientError(error) && error.code === "CONVERSION_EXPIRED"
            ? { id: conversionId, kind: "gone" }
            : {
                id: conversionId,
                kind: "failed",
                message: toErrorMessage(error, t("Could not open the project", "プロジェクトを開けませんでした"))
              }
        );
      }
    );
    return () => {
      active = false;
    };
  }, [conversionId, attempt, t]);

  const current = opening && opening.id === conversionId ? opening : null;
  const key = conversionId ? holders.current.get(conversionId) : `new-${fresh.generation}`;
  if (key) {
    const restored = current?.kind === "ready" ? current.conversion : undefined;
    return (
      <IllustratorPage
        key={key}
        initialFile={conversionId ? undefined : dropped}
        restored={restored}
        onConversion={(id) => {
          holders.current.set(id, key);
          navigate(artworkPath(id), { replace: true });
        }}
      />
    );
  }

  if (current?.kind === "gone") {
    return (
      <div role="alert" className="mx-auto mt-16 w-full max-w-md rounded border bg-card p-5">
        <h2 className="text-lg font-semibold">
          {t("This artwork project is no longer on this PC", "この図面プロジェクトはこの PC に残っていません")}
        </h2>
        <p className="mt-2 text-sm text-foreground">
          {t(
            "Projects are removed after a while without use, or when the PC holds too many. Bring the artwork in again to carry on.",
            "しばらく使われなかったプロジェクトや、保存数の上限を超えたプロジェクトは削除されます。続けるには図面をもう一度取り込んでください。"
          )}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" asChild>
            <Link to={ARTWORK_PATH}>{t("Bring in artwork", "図面を取り込む")}</Link>
          </Button>
          <Button asChild>
            <Link to="/">{t("Back to projects", "プロジェクト一覧へ戻る")}</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (current?.kind === "failed") {
    return (
      <div role="alert" className="mx-auto mt-16 w-full max-w-md rounded border bg-card p-5">
        <h2 className="text-lg font-semibold">{t("Could not open this project", "プロジェクトを開けませんでした")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{current.message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" asChild>
            <Link to="/">{t("Back to projects", "プロジェクト一覧へ戻る")}</Link>
          </Button>
          <Button onClick={() => setAttempt((value) => value + 1)}>{t("Try again", "再試行")}</Button>
        </div>
      </div>
    );
  }

  return (
    <div aria-busy="true" aria-label={t("Opening project", "プロジェクトを開いています")} className="space-y-3 p-8">
      <SkeletonBlock className="h-10 w-1/3" />
      <SkeletonBlock className="h-40 w-full" />
    </div>
  );
}
