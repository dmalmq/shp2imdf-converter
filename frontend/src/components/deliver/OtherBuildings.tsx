import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";

import { fetchProjects } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { splitFamily, type SplitFamily } from "../../lib/splitFamily";
import { Button } from "../ui";

/**
 * On a building split off an import, the other buildings of that import: once one is
 * delivered, the operator goes on to the next from here instead of hunting the project list.
 */
export function OtherBuildings({ sessionId }: { sessionId: string }) {
  const { t } = useUiLanguage();
  const [family, setFamily] = useState<SplitFamily | null>(null);

  useEffect(() => {
    let live = true;
    fetchProjects().then(
      (response) => live && setFamily(splitFamily(sessionId, response.projects)),
      // The list is a convenience; without it the page still delivers.
      () => live && setFamily(null)
    );
    return () => {
      live = false;
    };
  }, [sessionId]);

  if (!family || (family.siblings.length === 0 && !family.parent)) return null;
  const from = family.parent?.name;
  return (
    <section
      aria-labelledby="deliver-other-buildings"
      className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5"
    >
      <h2 id="deliver-other-buildings" className="font-display text-xl font-semibold text-foreground">
        {from
          ? t(`Other buildings from ${from}`, `${from} のほかの建物`)
          : t("Other buildings from this import", "この取り込みのほかの建物")}
      </h2>
      {family.siblings.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">
          {t("This was the only building split from the import.", "この取り込みから分割した建物はこれだけです。")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {family.siblings.map((building) => {
            const delivered = building.action === "open";
            const stage = building.track[building.stageNumber - 1]?.label;
            return (
              <li
                key={building.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium text-foreground">
                    {building.name ?? t("Unnamed building", "名前のない建物")}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {delivered ? <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 text-primary" /> : null}
                    {delivered ? t("Delivered", "納品済み") : stage ? t(stage.en, stage.ja) : null}
                  </span>
                </div>
                <Button size="sm" variant={delivered ? "outline" : "default"} asChild>
                  <Link to={building.href}>{delivered ? t("Open", "開く") : t("Continue", "続ける")}</Link>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {family.parent ? (
        <Link to={family.parent.href} className="text-[12.5px] font-medium text-primary hover:underline">
          {t(`Back to the import (${from ?? "unnamed"})`, `取り込み（${from ?? "名前なし"}）に戻る`)}
        </Link>
      ) : null}
    </section>
  );
}
