import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { useState } from "react";

import type { ExportFormatsPayload } from "../../api/client";
import type { PlacementState } from "../../hooks/useIllustratorPlacement";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { floorFit, type CurrentReferences, type FloorStatus } from "../../lib/floorStatus";
import { NextBar } from "../bringIn/NextBar";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { cn } from "@/lib/utils";
import { placedBy, statusDetail } from "./floorStatusCopy";

/** Where a floor came from in the drawing, and how many shapes it holds. */
export type DeliverFloor = {
  label: string;
  pages: number[] | null;
  box: boolean;
  shapes: number;
};

type FormatKey = keyof ExportFormatsPayload;

type Props = {
  state: PlacementState;
  statuses: Map<string, FloorStatus>;
  references: CurrentReferences;
  station: string;
  /** The converted file's stem, which names the archive and its files. */
  stem: string;
  floors: DeliverFloor[];
  /** Shape counts come from a decimated preview, not every shape. */
  shapesFromPreview: boolean;
  crsChoices: { value: string; label: string }[];
  outputCrs: string;
  onOutputCrsChange: (value: string) => void;
  formats: ExportFormatsPayload;
  onFormatsChange: (formats: ExportFormatsPayload) => void;
  onExport: () => void;
  error: string | null;
  onReview: (label: string) => void;
  onBackToMap: () => void;
};

/** Deliver for artwork: the outputs, every floor's fit, and one confirmation for floors not aligned. */
export function ArtworkDeliver({
  state,
  statuses,
  references,
  station,
  stem,
  floors,
  shapesFromPreview,
  crsChoices,
  outputCrs,
  onOutputCrsChange,
  formats,
  onFormatsChange,
  onExport,
  error,
  onReview,
  onBackToMap
}: Props) {
  const { t, uiLanguage } = useUiLanguage();
  const [confirming, setConfirming] = useState(false);
  const label = cn("text-[11px] font-medium", uiLanguage !== "ja" && "font-mono uppercase tracking-[0.06em]");
  const unaligned = state.floors
    .filter((floor) => statuses.get(floor.label)?.kind !== "aligned")
    .map((floor) => floor.label);
  const first = unaligned[0] ?? "";
  const ownFrames = state.floors.filter((floor) => !floor.linked || floor.pinned).map((floor) => floor.label);
  const count = state.floors.length;
  const archive = `${stem}_georeferenced.zip`;

  const OUTPUTS: { key: FormatKey; title: string; note: string; file: string }[] = [
    {
      key: "shapefile",
      title: t("Shapefile", "シェープファイル"),
      note: t(`One set per floor, ${count} ${count === 1 ? "set" : "sets"}.`, `フロアごとに1セット、${count} セット。`),
      file: "shapefiles/<floor>_<layer>.shp"
    },
    {
      key: "geopackage",
      title: t("GeoPackage", "GeoPackage"),
      note: t("Every floor in one file, a layer per floor and artwork layer.", "全フロアを1ファイルに。フロアと図面レイヤーごとに1レイヤー。"),
      file: `${stem}_georeferenced.gpkg`
    },
    {
      key: "qgis",
      title: t("QGIS project", "QGIS プロジェクト"),
      note: t("Opens the GeoPackage with the coordinate system set.", "座標系を設定した状態で GeoPackage を開きます。"),
      file: `${stem}_georeferenced.qgs`
    }
  ];
  const chosen = OUTPUTS.filter((output) => formats[output.key]).length;
  const usingSuggested = outputCrs === crsChoices[0]?.value;

  const run = () => (unaligned.length > 0 ? setConfirming(true) : onExport());
  const from = (floor: DeliverFloor | undefined) => {
    if (!floor?.pages?.length) return floor?.box ? t("Box", "範囲") : t("Whole drawing", "図面全体");
    const pages = t(`Page ${floor.pages.join(", ")}`, `ページ ${floor.pages.join("、")}`);
    return floor.box ? `${pages} · ${t("box", "範囲")}` : pages;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 items-start gap-8 overflow-auto px-14 pb-6 pt-7">
        <main className="flex min-w-0 flex-1 flex-col gap-4">
          <h1 className="font-display text-[30px] font-semibold leading-tight text-foreground">
            {t(`Deliver ${station}`, `${station} を書き出す`)}
          </h1>

          <section
            aria-label={t("Before you deliver", "書き出しの前に")}
            className={cn(
              "flex items-center gap-3 rounded-xl p-3.5",
              unaligned.length === 0 ? "bg-accent" : "bg-warning-surface"
            )}
          >
            {unaligned.length === 0 ? (
              <CheckCircle2 aria-hidden="true" className="h-[22px] w-[22px] shrink-0 text-primary" />
            ) : (
              <AlertTriangle aria-hidden="true" className="h-[22px] w-[22px] shrink-0 text-warning-foreground" />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className={cn("text-sm font-semibold", unaligned.length === 0 ? "text-primary" : "text-warning-foreground")}>
                {unaligned.length === 0
                  ? t(`All ${count} floors are aligned.`, `全 ${count} フロアの位置合わせが済んでいます。`)
                  : unaligned.length === 1
                    ? t(`${first} still needs alignment.`, `${first}はまだ位置合わせが必要です。`)
                    : t(
                        `${unaligned.length} floors still need alignment: ${unaligned.join(", ")}.`,
                        `位置合わせが必要なフロアが ${unaligned.length} 件あります：${unaligned.join("、")}。`
                      )}
              </p>
              <p className="text-[12.5px] leading-[1.45] text-muted-foreground">
                {unaligned.length > 0
                  ? t(
                      "Exporting now writes those floors where they sit on the map, which may be off the real building.",
                      "今書き出すと、そのフロアは地図上の今の位置のまま書き出され、実際の建物とずれている可能性があります。"
                    )
                  : ownFrames.length > 0 && count > 1
                    ? t(
                        `${ownFrames.join(", ")} ${ownFrames.length === 1 ? "has its" : "have their"} own scale and rotation; the other floors share one.`,
                        `${ownFrames.join("、")}は独自の縮尺と回転を持ち、他のフロアは共通です。`
                      )
                    : t("Every floor shares one scale and rotation.", "すべてのフロアが同じ縮尺と回転です。")}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 bg-card"
              onClick={() => (unaligned.length > 0 ? onReview(first) : onBackToMap())}
            >
              {unaligned.length > 0 ? t(`Review ${first}`, `${first}を確認`) : t("Review on the map", "地図で確認")}
            </Button>
          </section>

          <section aria-labelledby="artwork-outputs" className="flex flex-col gap-2.5">
            <div className="flex items-baseline gap-2.5">
              <h2 id="artwork-outputs" className={cn(label, "text-primary")}>
                {t("For GIS", "GIS 向け")}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t("Georeferenced floor plans, ready for QGIS", "座標付きの平面図。そのまま QGIS で開けます")}
              </p>
            </div>
            <div className="flex items-stretch gap-3">
              {OUTPUTS.map((output) => {
                const id = `export-format-${output.key}`;
                return (
                  <label
                    key={output.key}
                    htmlFor={id}
                    className={cn(
                      "flex min-w-0 flex-1 cursor-pointer flex-col gap-2 rounded-[14px] border bg-card p-4",
                      formats[output.key] ? "border-[1.5px] border-primary" : "border-border"
                    )}
                  >
                    <span className="flex items-start gap-2.5">
                      <Checkbox
                        id={id}
                        className="mt-px h-5 w-5 rounded-[5px]"
                        checked={formats[output.key]}
                        onCheckedChange={(checked) => onFormatsChange({ ...formats, [output.key]: checked === true })}
                      />
                      <span className="text-sm font-semibold text-foreground">{output.title}</span>
                    </span>
                    <span className="text-[12.5px] leading-[1.48] text-muted-foreground">{output.note}</span>
                    <span className="break-all pt-1 font-mono text-[11px] text-muted-foreground">{output.file}</span>
                  </label>
                );
              })}
            </div>
          </section>

          <section aria-labelledby="artwork-per-floor" className="flex flex-col gap-2.5">
            <h2 id="artwork-per-floor" className={cn(label, "text-muted-foreground")}>
              {t("Per floor", "フロアごと")}
            </h2>
            <div className="overflow-hidden rounded-xl border border-border bg-card px-4">
              <table className="w-full text-left text-[13px]" aria-label={t("Floor status", "フロアの状態")}>
                <thead>
                  <tr className={cn(label, "text-muted-foreground")}>
                    <th className="py-3 pr-3 font-medium">{t("Floor", "フロア")}</th>
                    <th className="py-3 pr-3 font-medium">{t("From", "元")}</th>
                    <th className="py-3 pr-3 font-medium">{t("Shapes", "図形")}</th>
                    <th className="py-3 pr-3 font-medium">{t("Status", "状態")}</th>
                    <th className="py-3 pr-3 font-medium">{t("Placed by", "配置方法")}</th>
                    <th className="py-3 pr-3 font-medium">{t("Fit", "精度")}</th>
                    <th className="py-3 pr-3 font-medium">{t("Frame", "フレーム")}</th>
                    <th className="py-3 font-medium">
                      <span className="sr-only">{t("Action", "操作")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {state.floors.map((placement) => {
                    const status = statuses.get(placement.label) ?? { kind: "needs-alignment", reason: "never" };
                    const floor = floors.find((item) => item.label === placement.label);
                    const aligned = status.kind === "aligned";
                    const rmse = floorFit(state, placement, references);
                    const detail = aligned ? null : statusDetail(status, t);
                    const frame = placement.pinned
                      ? t("pinned", "固定")
                      : placement.linked
                        ? t("linked", "リンク")
                        : t("own frame", "個別");
                    return (
                      <tr key={placement.label} data-floor-status={status.kind} className="border-t border-border align-top">
                        <td className="py-3 pr-3 font-semibold text-foreground">{placement.label}</td>
                        <td className="py-3 pr-3 text-muted-foreground">{from(floor)}</td>
                        <td className="py-3 pr-3 font-mono text-foreground">{floor ? floor.shapes : "—"}</td>
                        <td className="py-3 pr-3">
                          <Badge variant={aligned ? "success" : "warning"}>
                            {aligned ? t("Aligned", "位置合わせ済み") : t("Needs alignment", "位置合わせが必要")}
                          </Badge>
                          {detail ? <p className="mt-1 text-xs leading-4 text-muted-foreground">{detail}</p> : null}
                        </td>
                        <td className="py-3 pr-3 text-foreground">{placedBy(status, t)}</td>
                        <td className="py-3 pr-3 font-mono text-foreground">
                          {rmse !== null ? `RMSE ${rmse.toFixed(2)} m` : "—"}
                        </td>
                        <td className="py-3 pr-3">
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 font-mono text-[11px]",
                              placement.linked && !placement.pinned
                                ? "bg-muted text-muted-foreground"
                                : "border border-dashed border-artwork text-artwork"
                            )}
                          >
                            {frame}
                          </span>
                        </td>
                        <td className="py-2 text-right">
                          {aligned ? null : (
                            <Button size="sm" variant="outline" onClick={() => onReview(placement.label)}>
                              {t(`Review ${placement.label}`, `${placement.label}を確認`)}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {shapesFromPreview ? (
              <p className="text-xs text-muted-foreground">
                {t(
                  "Shape counts are from the preview. Export counts every shape again from the full drawing.",
                  "図形数はプレビューからの数です。書き出し時に元の図面からすべて数え直します。"
                )}
              </p>
            ) : null}
          </section>

          {error ? (
            <p role="alert" className="text-[13px] leading-[18px] text-destructive">
              {error}
            </p>
          ) : null}
        </main>

        <aside className="flex w-[420px] shrink-0 flex-col gap-3.5">
          <section aria-labelledby="artwork-files" className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5">
            <h2 id="artwork-files" className="font-display text-xl font-semibold text-foreground">
              {t("What you’ll get", "作成されるファイル")}
            </h2>
            <ul aria-label={t("Files", "ファイル")} className="flex flex-col gap-1.5 rounded-lg bg-muted p-3.5 font-mono text-xs text-foreground">
              <li className="break-all">{archive}</li>
              {formats.shapefile ? (
                <li className="flex flex-col gap-1">
                  <span>└ shapefiles/</span>
                  <span className="pl-4 text-[11px] text-muted-foreground">└ {state.floors.map((floor) => floor.label).join(" · ")}</span>
                  <span className="pl-8 text-[11px] text-muted-foreground">
                    {t(".shp .dbf .shx .prj .cpg per artwork layer", "図面レイヤーごとに .shp .dbf .shx .prj .cpg")}
                  </span>
                </li>
              ) : null}
              {formats.geopackage ? <li className="break-all">└ {stem}_georeferenced.gpkg</li> : null}
              {formats.qgis ? (
                <li className="break-all">
                  └ {stem}_georeferenced.qgs{" "}
                  <span className="text-[11px] text-muted-foreground">{t("opens the .gpkg", ".gpkg を開く")}</span>
                </li>
              ) : null}
              <li>└ export_report.json</li>
            </ul>

            <div className="flex flex-col gap-2 rounded-lg bg-info-muted p-3.5">
              <p className={cn(label, "text-info")}>{t("Coordinate system", "座標系")}</p>
              <Select value={outputCrs} onValueChange={onOutputCrsChange}>
                <SelectTrigger aria-label={t("Output CRS", "出力座標系")} className="bg-card">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {crsChoices.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs leading-[1.45] text-info">
                {usingSuggested
                  ? t(
                      "Picked from where the artwork sits. Rotation is measured from true north.",
                      "図面の位置から選びました。回転は真北基準です。"
                    )
                  : t("Manual override.", "手動で指定しています。")}
              </p>
            </div>
            <p className="text-xs leading-[1.45] text-muted-foreground">
              {t(
                "Which shapes belong to each floor is checked again from the full drawing when you export.",
                "各フロアに含まれる図形は、書き出し時に元の図面から判定し直します。"
              )}
            </p>
          </section>
        </aside>
      </div>

      <NextBar
        step={{
          title: {
            en: `Creates ${archive} with ${chosen} ${chosen === 1 ? "output" : "outputs"}`,
            ja: `${archive}（${chosen} 種類の出力）を作成します`
          },
          detail: {
            en: "You can come back and export again at any time; exporting changes nothing in the project.",
            ja: "いつでも戻って書き出し直せます。書き出してもプロジェクトは変わりません。"
          },
          action: {
            en: `Export ${count} ${count === 1 ? "floor" : "floors"}`,
            ja: `${count} フロアを書き出し`
          },
          blocked: chosen === 0 ? { en: "Choose at least one output format", ja: "出力形式を1つ以上選択してください" } : null
        }}
        busyLabel={{ en: "Exporting…", ja: "書き出し中…" }}
        onGo={run}
      />

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogTitle>
            {unaligned.length === 1
              ? t(`Export with ${first} not aligned?`, `${first}は位置合わせが済んでいません。書き出しますか？`)
              : t(
                  `Export with ${unaligned.length} floors not aligned?`,
                  `位置合わせが済んでいないフロアが ${unaligned.length} 件あります。書き出しますか？`
                )}
          </DialogTitle>
          <DialogDescription>
            {t(
              `${unaligned.join(", ")} will be written where ${unaligned.length === 1 ? "it sits" : "they sit"} now, which may be off the real building.`,
              `${unaligned.join("、")}は今の位置のまま書き出されるため、実際の建物とずれている可能性があります。`
            )}
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setConfirming(false);
                onReview(first);
              }}
            >
              {t(`Review ${first}`, `${first}を確認`)}
            </Button>
            <Button
              onClick={() => {
                setConfirming(false);
                onExport();
              }}
            >
              {t("Export anyway", "このまま書き出す")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
