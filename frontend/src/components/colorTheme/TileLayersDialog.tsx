import { ChevronRight } from "lucide-react";
import { useState } from "react";

import type { TileLayerNode } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  defaultTileChoice,
  setTicked,
  tickState,
  tileLayerCounts,
  type TileChoice,
  type TileLayerCounts
} from "../../lib/tileLayers";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DisabledHint,
  ScrollArea
} from "../ui";
import { cn } from "@/lib/utils";

type T = (english: string, japanese: string) => string;

const formatCount = (value: number) => value.toLocaleString("en-US");

/** "12 groups, 48 layers · 30 to tile · 9 excluded by pattern" */
export function tileLayerSummary({ groups, layers, chosen, excluded }: TileLayerCounts, t: T): string {
  return t(
    `${formatCount(groups)} ${groups === 1 ? "group" : "groups"}, ${formatCount(layers)} ${layers === 1 ? "layer" : "layers"} · ${formatCount(chosen)} to tile · ${formatCount(excluded)} excluded by pattern`,
    `グループ ${formatCount(groups)} 件、レイヤー ${formatCount(layers)} 件 · タイル化 ${formatCount(chosen)} 件 · パターンで除外 ${formatCount(excluded)} 件`
  );
}

/** The map's layer tree with a tick per layer and a three-state tick per group. Changes apply on "Use these layers". */
export function TileLayersDialog({
  open,
  onOpenChange,
  map,
  layers,
  choice,
  onChoose
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  map: string;
  layers: TileLayerNode[];
  choice: TileChoice;
  onChoose: (choice: TileChoice) => void;
}) {
  const { t } = useUiLanguage();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-[680px] flex-col gap-0 p-0">
        <div className="flex flex-col gap-1.5 border-b border-border px-6 pb-4 pt-6">
          <DialogTitle>{t("Layers to tile", "タイルにするレイヤー")}</DialogTitle>
          <DialogDescription>
            {t(
              `Ticked layers of the map “${map}” go into the vector tiles. The list starts from the project as saved, with the layers the exclusion patterns name unticked. Nothing here is kept: the next build starts from the project again.`,
              `マップ「${map}」のうちチェックしたレイヤーがベクタータイルになります。保存されたプロジェクトの表示状態から始まり、除外パターンに当たるレイヤーはチェックが外れています。ここでの変更は保存されず、次の作成はまたプロジェクトから始まります。`
            )}
          </DialogDescription>
        </div>
        {open ? <Chooser layers={layers} initial={choice} onChoose={onChoose} onCancel={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function Chooser({
  layers,
  initial,
  onChoose,
  onCancel
}: {
  layers: TileLayerNode[];
  initial: TileChoice;
  onChoose: (choice: TileChoice) => void;
  onCancel: () => void;
}) {
  const { t } = useUiLanguage();
  const [draft, setDraft] = useState(initial);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(layers.filter((node) => node.group).map((node) => node.uri)));
  const counts = tileLayerCounts(layers, draft);
  const toggle = (uri: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(uri)) next.add(uri);
      return next;
    });
  return (
    <>
      <p aria-live="polite" className="border-b border-border px-6 py-2.5 text-[12.5px] font-medium text-foreground">
        {tileLayerSummary(counts, t)}
      </p>
      <ScrollArea className="min-h-0 flex-1">
        <ul aria-label={t("Layers", "レイヤー")} className="flex flex-col py-1.5">
          {layers.map((node) => (
            <Row key={node.uri} node={node} depth={0} draft={draft} setDraft={setDraft} open={open} toggle={toggle} />
          ))}
        </ul>
      </ScrollArea>
      <DialogFooter className="justify-between border-t border-border px-6 py-4">
        <Button variant="ghost" onClick={() => setDraft(defaultTileChoice(layers))}>
          {t("Reset to defaults", "既定に戻す")}
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onCancel}>
            {t("Cancel", "キャンセル")}
          </Button>
          <DisabledHint hint={counts.chosen === 0 ? t("Tick at least one layer.", "レイヤーを 1 つ以上チェックしてください。") : null}>
            <Button disabled={counts.chosen === 0} onClick={() => onChoose(draft)}>
              {t("Use these layers", "このレイヤーを使う")}
            </Button>
          </DisabledHint>
        </div>
      </DialogFooter>
    </>
  );
}

function Row({
  node,
  depth,
  draft,
  setDraft,
  open,
  toggle
}: {
  node: TileLayerNode;
  depth: number;
  draft: TileChoice;
  setDraft: (update: (choice: TileChoice) => TileChoice) => void;
  open: ReadonlySet<string>;
  toggle: (uri: string) => void;
}) {
  const { t } = useUiLanguage();
  const expanded = node.group && open.has(node.uri);
  const ticked = tickState(node, draft);
  const empty = node.group && node.children.length === 0;
  return (
    <li>
      <div
        className="flex min-h-8 items-center gap-2 py-1 pr-6 hover:bg-muted/60"
        style={{ paddingLeft: `${24 + depth * 20}px` }}
      >
        {node.group ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? t(`Collapse ${node.name}`, `${node.name} を閉じる`) : t(`Expand ${node.name}`, `${node.name} を開く`)}
            onClick={() => toggle(node.uri)}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronRight aria-hidden="true" className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")} />
          </button>
        ) : (
          <span aria-hidden="true" className="w-5 shrink-0" />
        )}
        <Checkbox
          aria-label={node.name}
          checked={ticked}
          disabled={empty}
          onCheckedChange={() => setDraft((choice) => setTicked(choice, node, ticked !== true))}
        />
        <span className={cn("min-w-0 truncate text-[13px]", node.group ? "font-medium text-foreground" : "text-foreground")}>
          {node.name}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {node.excluded_by !== null ? (
            <span className="rounded-sm bg-warning-surface px-1.5 py-0.5 font-mono text-[11px] text-warning-foreground">
              {t(`excluded · ${node.excluded_by}`, `除外 · ${node.excluded_by}`)}
            </span>
          ) : null}
          {!node.visible ? (
            <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {t("hidden in project", "プロジェクトで非表示")}
            </span>
          ) : null}
        </span>
      </div>
      {expanded ? (
        <ul>
          {node.children.map((child) => (
            <Row key={child.uri} node={child} depth={depth + 1} draft={draft} setDraft={setDraft} open={open} toggle={toggle} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
