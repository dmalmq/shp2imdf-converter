import type { ReactNode } from "react";

import type { ImportProfile } from "../../store/useAppStore";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import type { FloorFound } from "../../lib/bringIn";
import { cn } from "@/lib/utils";
import { RadioGroup, RadioGroupItem } from "../ui";

function RailCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3 rounded-[14px] border border-border bg-card p-5">
      <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

type ProfileProps = {
  value: ImportProfile;
  onChange?: (value: ImportProfile) => void;
  /** Shown under the choice while IMDF schema is chosen. */
  imdfOptions?: ReactNode;
};

/** Standard or IMDF schema. Without `onChange` the project's choice is shown, not offered. */
export function ProfileChoice({ value, onChange, imdfOptions }: ProfileProps) {
  const { t } = useUiLanguage();
  const options: Array<{ id: ImportProfile; title: string; body: string }> = [
    {
      id: "standard",
      title: t("Standard · recommended", "標準 · おすすめ"),
      body: t(
        "Your files use their own codes. In Set up we’ll help match each code to an IMDF category.",
        "独自のコードを使ったファイルです。設定で各コードを IMDF のカテゴリに対応付けます。"
      )
    },
    {
      id: "imdf_shapefile",
      title: t("IMDF schema", "IMDF スキーマ"),
      body: t(
        "The files already follow IMDF. Skip the matching and go straight to Check.",
        "ファイルはすでに IMDF に沿っています。対応付けを省いてチェックへ進みます。"
      )
    }
  ];

  return (
    <RailCard title={t("How should we read these?", "どの形式で読み込みますか？")}>
      <RadioGroup
        value={value}
        disabled={!onChange}
        onValueChange={(next) => onChange?.(next as ImportProfile)}
        className="gap-3"
      >
        {options.map((option) => {
          const chosen = option.id === value;
          return (
            <label
              key={option.id}
              htmlFor={`profile-${option.id}`}
              className={cn(
                "flex gap-3 rounded-[10px] border p-3.5",
                chosen ? "border-[1.5px] border-primary bg-accent/40" : "border-border",
                onChange ? "cursor-pointer" : "cursor-default"
              )}
            >
              <RadioGroupItem id={`profile-${option.id}`} value={option.id} className="mt-0.5 h-[18px] w-[18px] border-2" />
              <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="text-[13px] font-semibold text-foreground">{option.title}</span>
                <span className="text-xs leading-[1.45] text-muted-foreground">{option.body}</span>
              </span>
            </label>
          );
        })}
      </RadioGroup>
      {value === "imdf_shapefile" ? imdfOptions : null}
      {onChange ? null : (
        <p className="text-xs leading-[1.45] text-muted-foreground">
          {t(
            "Chosen when the files were brought in. Bring them in again to read them the other way.",
            "取り込み時に選んだ形式です。別の形式で読むにはもう一度取り込んでください。"
          )}
        </p>
      )}
    </RailCard>
  );
}

/** The floors the file names gave, and any two that share a height. */
export function FloorsFound({ floors }: { floors: FloorFound[] | null }) {
  const { t } = useUiLanguage();
  const shared = (floors ?? []).filter((floor) => floor.labels.length > 1);

  return (
    <RailCard title={t("Floors we found", "見つかった階")}>
      {floors === null ? (
        <p className="text-xs leading-[1.45] text-muted-foreground">
          {t("Floors appear here once the files are read.", "ファイルを読み込むとここに階が表示されます。")}
        </p>
      ) : floors.length === 0 ? (
        <p className="text-xs leading-[1.45] text-muted-foreground">
          {t("No file name said which floor it is on.", "階がわかるファイル名はありませんでした。")}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {floors.flatMap((floor) =>
            floor.labels.map((label) => (
              <li key={`${floor.ordinal}-${label}`} className="rounded-full bg-muted px-2.5 py-1 font-mono text-xs font-medium text-foreground">
                {label}
              </li>
            ))
          )}
        </ul>
      )}
      {shared.map((floor) => {
        const names = floor.labels.join(t(" and ", "と"));
        return (
          <p key={floor.ordinal} className="rounded-[10px] bg-warning-surface p-3 text-xs leading-[1.45] text-warning-foreground">
            {t(
              `${names} look like the same height. You’ll confirm their order in Set up — nothing to do yet.`,
              `${names}は同じ高さのようです。順序は設定で確認します。今は何もしなくて大丈夫です。`
            )}
          </p>
        );
      })}
    </RailCard>
  );
}

export function WhyGuesses() {
  const { t } = useUiLanguage();
  return (
    <section className="flex flex-col gap-1.5 px-1 pt-1">
      <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
        {t("Why a guess can be wrong", "推定が外れる理由")}
      </h2>
      <p className="text-[12.5px] leading-[1.5] text-muted-foreground">
        {t(
          "We rely on names like <station>_<floor>_<type>. Files exported with other names still work — just tell us what they are.",
          "<駅>_<階>_<種類> のような名前を手がかりにしています。ほかの名前のファイルも使えます。種類を教えてください。"
        )}
      </p>
    </section>
  );
}
