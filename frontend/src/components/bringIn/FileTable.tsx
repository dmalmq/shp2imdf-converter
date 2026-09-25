import { useState, type ReactNode } from "react";
import { CheckCircle2 } from "lucide-react";

import type { UpdateFileRequest } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  TYPE_LABELS,
  TYPE_OPTIONS,
  floorLabel,
  type BringInRow,
  type NeedReason,
  type QueuedDataset
} from "../../lib/bringIn";
import { cn } from "@/lib/utils";
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui";

const DETECTED_COLUMNS = "grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_7.5rem_4.5rem]";
const QUEUED_COLUMNS = "grid-cols-[minmax(0,1.3fr)_8rem_5rem_minmax(0,1fr)]";
const LOOK_RIGHT_SHOWN = 8;

type T = (english: string, japanese: string) => string;

function typeLabel(type: string, t: T): string {
  const label = TYPE_LABELS[type];
  return label ? t(label.en, label.ja) : type;
}

function TableShell({ columns, head, children }: { columns: string; head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[14px] border border-border bg-card">
      <div
        className={cn("grid items-center gap-4 bg-muted px-5 py-2.5 text-xs font-medium text-muted-foreground", columns)}
        role="presentation"
      >
        {head.map((cell, index) => (
          <span key={index}>{cell}</span>
        ))}
      </div>
      {children}
    </div>
  );
}

function GroupHeading({ tone, children }: { tone: "danger" | "ok"; children: ReactNode }) {
  return (
    <h3
      className={cn(
        "flex items-center gap-2 px-5 pb-1.5 pt-3 text-[13px] font-semibold",
        tone === "danger" ? "text-destructive" : "text-primary"
      )}
    >
      <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", tone === "danger" ? "bg-destructive" : "bg-primary")} />
      {children}
    </h3>
  );
}

function Row({
  columns,
  needsYou,
  children,
  ...hover
}: {
  columns: string;
  needsYou: boolean;
  children: ReactNode;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  return (
    <li
      {...hover}
      className={cn("grid items-center gap-4 border-b border-border px-5 py-2.5 last:border-b-0", columns, needsYou && "bg-destructive-muted/50")}
    >
      {children}
    </li>
  );
}

function FileName({ name, note, tone }: { name: string; note?: string | null; tone?: "danger" | "muted" }) {
  return (
    <span className="flex min-w-0 flex-col gap-[3px]">
      <span className="truncate font-mono text-[12.5px] text-foreground" title={name}>
        {name}
      </span>
      {note ? (
        <span className={cn("text-xs leading-[1.4]", tone === "danger" ? "text-destructive" : "text-muted-foreground")}>
          {note}
        </span>
      ) : null}
    </span>
  );
}

function reasonText(row: BringInRow, t: T): string {
  const has = (reason: NeedReason) => row.reasons.includes(reason);
  const noType = has("unknown-type") || has("shape-guess");
  const sentence = noType && has("no-floor")
    ? t("The name doesn’t say what this is or which floor.", "ファイル名から種類も階もわかりません。")
    : noType
      ? t("The name doesn’t say what this is.", "ファイル名から種類がわかりません。")
      : t("The name doesn’t say which floor.", "ファイル名から階がわかりません。");
  if (!row.shapeGuess) return sentence;
  const guess = typeLabel(row.shapeGuess, t);
  return `${sentence} ${t(`Its shapes look like ${guess}.`, `形状は「${guess}」に見えます。`)}`;
}

type DetectedProps = {
  needsYou: BringInRow[];
  looksRight: BringInRow[];
  floorChoices: number[];
  /** Files with a choice on its way to the server. */
  saving: ReadonlySet<string>;
  onResolve: (stem: string, payload: UpdateFileRequest) => void;
  /** The file shown alone on the map, if any. */
  selected?: string | null;
  onHover?: (stem: string | null) => void;
  onSelect?: (stem: string | null) => void;
};

/** What was read from each file, the ones that need a decision first. */
export function DetectedTable({
  needsYou,
  looksRight,
  floorChoices,
  saving,
  onResolve,
  selected = null,
  onHover,
  onSelect
}: DetectedProps) {
  const { t } = useUiLanguage();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? looksRight : looksRight.slice(0, LOOK_RIGHT_SHOWN);
  const hidden = looksRight.slice(shown.length);
  const hiddenFloors = [...new Set(hidden.flatMap((row) => (row.floor.kind === "level" ? [row.floor.label] : [])))];

  const floorCell = (row: BringInRow) => {
    if (row.floor.kind === "level") return <span className="text-[13px] font-medium text-foreground">{row.floor.label}</span>;
    if (row.floor.kind === "whole-station")
      return <span className="text-[13px] font-medium text-foreground">{t("Whole station", "駅全体")}</span>;
    if (row.floor.kind === "none") return <span className="font-mono text-xs text-muted-foreground">—</span>;
    return (
      <Select
        value=""
        disabled={saving.has(row.stem)}
        onValueChange={(value) => onResolve(row.stem, { detected_level: Number(value) })}
      >
        <SelectTrigger className="h-8 bg-card text-[13px]" aria-label={t(`Floor of ${row.stem}`, `${row.stem} の階`)}>
          <SelectValue placeholder={t("Choose…", "選択…")} />
        </SelectTrigger>
        <SelectContent>
          {floorChoices.map((ordinal) => (
            <SelectItem key={ordinal} value={String(ordinal)}>
              {floorLabel(ordinal)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  };

  const typeCell = (row: BringInRow) => (
    <Select
      value={row.type ?? ""}
      disabled={saving.has(row.stem)}
      onValueChange={(value) => onResolve(row.stem, { detected_type: value })}
    >
      <SelectTrigger
        className={cn(
          "h-8 text-[13px]",
          row.type ? "-ml-2 gap-2 border-transparent bg-transparent px-2 shadow-none hover:border-border hover:bg-card" : "bg-card"
        )}
        aria-label={t(`What ${row.stem} is`, `${row.stem} の種類`)}
      >
        {row.type ? <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-primary" /> : null}
        <span className="min-w-0 flex-1 truncate text-left">
          <SelectValue placeholder={t("Choose what this is…", "種類を選択…")} />
        </span>
      </SelectTrigger>
      <SelectContent>
        {TYPE_OPTIONS.map((option) => (
          <SelectItem key={option} value={option}>
            {typeLabel(option, t)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const rowProps = (row: BringInRow) => ({
    onMouseEnter: onHover ? () => onHover(row.stem) : undefined,
    onMouseLeave: onHover ? () => onHover(null) : undefined
  });
  const nameCell = (row: BringInRow, note: string | null | undefined, tone: "danger" | "muted") =>
    onSelect ? (
      <button
        type="button"
        aria-pressed={selected === row.stem}
        title={t("Show only this file on the map", "このファイルだけを地図に表示")}
        onClick={() => onSelect(selected === row.stem ? null : row.stem)}
        className={cn(
          "min-w-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected === row.stem && "underline decoration-primary decoration-2 underline-offset-4"
        )}
      >
        <FileName name={row.stem} note={note} tone={tone} />
      </button>
    ) : (
      <FileName name={row.stem} note={note} tone={tone} />
    );

  return (
    <TableShell
      columns={DETECTED_COLUMNS}
      head={[t("File", "ファイル"), t("What we think it is", "推定した種類"), t("Floor", "階"), t("Shapes", "図形数")]}>
      {needsYou.length > 0 ? (
        <section aria-label={t("Needs you", "要確認")}>
          <GroupHeading tone="danger">{t(`Needs you · ${needsYou.length}`, `要確認 · ${needsYou.length}`)}</GroupHeading>
          <ul>
            {needsYou.map((row) => (
              <Row key={row.stem} columns={DETECTED_COLUMNS} needsYou {...rowProps(row)}>
                {nameCell(row, reasonText(row, t), "danger")}
                {typeCell(row)}
                {floorCell(row)}
                <span className="font-mono text-xs text-muted-foreground">{row.shapes}</span>
              </Row>
            ))}
          </ul>
        </section>
      ) : null}
      {looksRight.length > 0 ? (
        <section aria-label={t("Look right", "問題なし")}>
          <GroupHeading tone="ok">{t(`Look right · ${looksRight.length}`, `問題なし · ${looksRight.length}`)}</GroupHeading>
          <ul>
            {shown.map((row) => (
              <Row key={row.stem} columns={DETECTED_COLUMNS} needsYou={false} {...rowProps(row)}>
                {nameCell(row, row.warnings[0], "muted")}
                {typeCell(row)}
                {floorCell(row)}
                <span className="font-mono text-xs text-muted-foreground">{row.shapes}</span>
              </Row>
            ))}
          </ul>
          {hidden.length > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="px-5 py-3 text-[13px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {hiddenFloors.length > 0
                ? t(`+ ${hidden.length} more on ${hiddenFloors.join(", ")}`, `ほか ${hidden.length} 件（${hiddenFloors.join("、")}）`)
                : t(`+ ${hidden.length} more`, `ほか ${hidden.length} 件`)}
            </button>
          ) : null}
        </section>
      ) : null}
    </TableShell>
  );
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type QueuedProps = {
  datasets: QueuedDataset[];
  onAddParts: () => void;
  onLeaveOut: (key: string) => void;
};

/** Files waiting to be read: whatever cannot be read as it stands comes first. */
export function QueuedTable({ datasets, onAddParts, onLeaveOut }: QueuedProps) {
  const { t } = useUiLanguage();
  const incomplete = datasets.filter((dataset) => dataset.missing.length > 0);
  const ready = datasets.filter((dataset) => dataset.missing.length === 0);
  const kind = (dataset: QueuedDataset) =>
    dataset.kind === "shapefile"
      ? t("Shapefile", "シェープファイル")
      : dataset.kind === "gpkg"
        ? t("GeoPackage", "GeoPackage")
        : t("Zip archive", "Zip アーカイブ");
  const leaveOut = (dataset: QueuedDataset) => (
    <Button variant="outline" size="sm" onClick={() => onLeaveOut(dataset.key)} aria-label={t(`Leave out ${dataset.name}`, `${dataset.name} を除外`)}>
      {t("Leave it out", "除外する")}
    </Button>
  );

  return (
    <TableShell columns={QUEUED_COLUMNS} head={[t("File", "ファイル"), t("Kind", "種類"), t("Size", "サイズ"), ""]}>
      {incomplete.length > 0 ? (
        <section aria-label={t("Needs you", "要確認")}>
          <GroupHeading tone="danger">{t(`Needs you · ${incomplete.length}`, `要確認 · ${incomplete.length}`)}</GroupHeading>
          <ul>
            {incomplete.map((dataset) => {
              const missing = dataset.missing.join(", ");
              return (
                <Row key={dataset.key} columns={QUEUED_COLUMNS} needsYou>
                  <FileName
                    name={dataset.name}
                    note={t(
                      `Its ${missing} is missing, so the shapes can’t be read.`,
                      `${missing} がないため図形を読み込めません。`
                    )}
                    tone="danger"
                  />
                  <span className="text-[13px] text-foreground">{kind(dataset)}</span>
                  <span className="font-mono text-xs text-muted-foreground">{sizeLabel(dataset.bytes)}</span>
                  <span className="flex justify-end gap-2">
                    <Button size="sm" onClick={onAddParts}>
                      {t(`Add the ${dataset.missing[0]}`, `${dataset.missing[0]} を追加`)}
                    </Button>
                    {leaveOut(dataset)}
                  </span>
                </Row>
              );
            })}
          </ul>
        </section>
      ) : null}
      {ready.length > 0 ? (
        <section aria-label={t("Ready to read", "読み込み可能")}>
          <GroupHeading tone="ok">{t(`Ready to read · ${ready.length}`, `読み込み可能 · ${ready.length}`)}</GroupHeading>
          <ul>
            {ready.map((dataset) => (
              <Row key={dataset.key} columns={QUEUED_COLUMNS} needsYou={false}>
                <FileName
                  name={dataset.name}
                  note={
                    dataset.skipped
                      ? t(
                          `${dataset.parts.join(", ")} · no .shp, so this is passed over`,
                          `${dataset.parts.join(", ")} · .shp がないため読み込まれません`
                        )
                      : dataset.parts.join(", ") || null
                  }
                  tone="muted"
                />
                <span className="text-[13px] text-foreground">{kind(dataset)}</span>
                <span className="font-mono text-xs text-muted-foreground">{sizeLabel(dataset.bytes)}</span>
                <span className="flex justify-end">{leaveOut(dataset)}</span>
              </Row>
            ))}
          </ul>
        </section>
      ) : null}
    </TableShell>
  );
}
