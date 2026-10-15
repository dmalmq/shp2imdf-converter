import { ChevronRight } from "lucide-react";
import { useState } from "react";

import type { TileLayerNode } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  defaultTileSelection,
  kindTickState,
  mapLayerCount,
  setKindTicked,
  setTicked,
  tickState,
  tileLayerCounts,
  tileLayerKinds,
  tileMap,
  type TileChoice,
  type TileLayerCounts,
  type TileLayerKind,
  type TileMaps,
  type TileSelection
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
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

/**
 * A map's layer tree with a tick per layer and a three-state tick per group, and above it, when the project has
 * more than one map, the map to tile. Changes apply on "Use these layers".
 */
export function TileLayersDialog({
  open,
  onOpenChange,
  maps,
  selection,
  onChoose
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  maps: TileMaps;
  selection: TileSelection;
  onChoose: (selection: TileSelection) => void;
}) {
  const { t } = useUiLanguage();
  const only = maps.maps.length === 1 ? maps.maps[0].name : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-[680px] flex-col gap-0 p-0">
        <div className="flex flex-col gap-1.5 border-b border-border px-6 pb-4 pt-6">
          <DialogTitle>{t("Layers to tile", "タイルにするレイヤー")}</DialogTitle>
          <DialogDescription>
            {only !== null
              ? t(
                  `Ticked layers of the map “${only}” go into the vector tiles. Every layer starts ticked, on every floor, except those an exclusion pattern names and layers that draw points. Nothing here is kept: the next build starts from the project again.`,
                  `マップ「${only}」のうちチェックしたレイヤーがベクタータイルになります。すべての階のレイヤーにチェックが入った状態から始まり、除外パターンに当たるレイヤーとポイントのレイヤーはチェックが外れています。ここでの変更は保存されず、次の作成はまたプロジェクトから始まります。`
                )
              : t(
                  `Ticked layers of the chosen map go into the vector tiles. Every layer starts ticked, on every floor, except those an exclusion pattern names and layers that draw points. Nothing here is kept: the next build starts from the project again.`,
                  `選んだマップのうちチェックしたレイヤーがベクタータイルになります。すべての階のレイヤーにチェックが入った状態から始まり、除外パターンに当たるレイヤーとポイントのレイヤーはチェックが外れています。ここでの変更は保存されず、次の作成はまたプロジェクトから始まります。`
                )}
          </DialogDescription>
        </div>
        {open ? <Chooser maps={maps} initial={selection} onChoose={onChoose} onCancel={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

const topGroups = (layers: readonly TileLayerNode[]): ReadonlySet<string> =>
  new Set(layers.filter((node) => node.group).map((node) => node.uri));

function Chooser({
  maps,
  initial,
  onChoose,
  onCancel
}: {
  maps: TileMaps;
  initial: TileSelection;
  onChoose: (selection: TileSelection) => void;
  onCancel: () => void;
}) {
  const { t } = useUiLanguage();
  const [draft, setDraft] = useState(initial);
  const layers = tileMap(maps, draft.map).layers;
  const [open, setOpen] = useState(() => topGroups(layers));
  const counts = tileLayerCounts(layers, draft.layers);
  const toggle = (uri: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(uri)) next.add(uri);
      return next;
    });
  const reset = (selection: TileSelection) => {
    setDraft(selection);
    setOpen(topGroups(tileMap(maps, selection.map).layers));
  };
  const setLayers = (update: (choice: TileChoice) => TileChoice) =>
    setDraft((current) => ({ ...current, layers: update(current.layers) }));
  return (
    <>
      {maps.maps.length > 1 ? <MapPicker maps={maps} value={draft.map} onChange={(id) => reset(defaultTileSelection(maps, id))} /> : null}
      <p aria-live="polite" className="border-b border-border px-6 py-2.5 text-[12.5px] font-medium text-foreground">
        {tileLayerSummary(counts, t)}
      </p>
      <LayerKinds kinds={tileLayerKinds(layers)} draft={draft.layers} setDraft={setLayers} />
      {/* Native scrolling: the dialog only has a max-height, so Radix ScrollArea's h-full viewport grew to the whole list and was clipped. */}
      <div key={draft.map} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <ul aria-label={t("Layers", "レイヤー")} className="flex flex-col py-1.5">
          {layers.map((node) => (
            <Row key={node.uri} node={node} depth={0} draft={draft.layers} setDraft={setLayers} open={open} toggle={toggle} />
          ))}
        </ul>
      </div>
      <DialogFooter className="justify-between border-t border-border px-6 py-4">
        <Button variant="ghost" onClick={() => reset(defaultTileSelection(maps))}>
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

/** Each kind of layer the defaults leave out, ticked or unticked everywhere at once: openings on every floor, say. */
function LayerKinds({
  kinds,
  draft,
  setDraft
}: {
  kinds: readonly TileLayerKind[];
  draft: TileChoice;
  setDraft: (update: (choice: TileChoice) => TileChoice) => void;
}) {
  const { t } = useUiLanguage();
  if (kinds.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-b border-border px-6 py-3">
      <p id="tile-layer-kinds" className="text-[12px] text-muted-foreground">
        {t("Tick or untick a kind of layer on every floor at once.", "種類ごとに、すべての階のレイヤーをまとめてチェック・解除します。")}
      </p>
      <ul aria-labelledby="tile-layer-kinds" className="flex flex-wrap gap-1.5">
        {kinds.map((kind) => {
          const ticked = kindTickState(kind, draft);
          const chosen = kind.layers.filter((uri) => draft.has(uri)).length;
          const label = kind.kind === "points" ? t("Point layers", "ポイントのレイヤー") : kind.pattern;
          return (
            <li key={kind.kind === "points" ? "points" : `pattern:${kind.pattern}`}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 hover:bg-muted/60">
                <Checkbox
                  aria-label={label}
                  checked={ticked}
                  onCheckedChange={() => setDraft((choice) => setKindTicked(choice, kind, ticked !== true))}
                />
                <span className={cn("text-[12.5px] text-foreground", kind.kind === "pattern" && "font-mono")}>{label}</span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {formatCount(chosen)}/{formatCount(kind.layers.length)}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function defaultReason(maps: TileMaps, t: T): string {
  const name = tileMap(maps, maps.default_map).name;
  switch (maps.default_reason) {
    case "only_with_layers":
      return t(`“${name}” is the default: it is the only map with layers.`, `既定は「${name}」です。レイヤーがあるのはこのマップだけです。`);
    case "most_layers":
      return t(`“${name}” is the default: it has the most layers.`, `既定は「${name}」です。レイヤーがいちばん多いマップです。`);
    case "first_of_most":
      return t(
        `“${name}” is the default: it comes first of the maps with the most layers.`,
        `既定は「${name}」です。レイヤー数がいちばん多いマップのうち、最初のマップです。`
      );
  }
}

/** Switching maps starts that map from its own defaults: a choice of layers belongs to one map. */
function MapPicker({ maps, value, onChange }: { maps: TileMaps; value: string; onChange: (id: string) => void }) {
  const { t } = useUiLanguage();
  return (
    <div className="flex flex-col gap-1.5 border-b border-border px-6 py-3">
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-[12.5px] font-medium text-foreground">{t("Map", "マップ")}</span>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger aria-label={t("Map to tile", "タイルにするマップ")} className="h-8 max-w-[380px] bg-card text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {maps.maps.map((map) => {
              const count = mapLayerCount(map);
              return (
                <SelectItem key={map.id} value={map.id} disabled={count === 0}>
                  {count === 0
                    ? t(`${map.name} · no layers`, `${map.name} · レイヤーなし`)
                    : t(
                        `${map.name} · ${formatCount(count)} ${count === 1 ? "layer" : "layers"}`,
                        `${map.name} · レイヤー ${formatCount(count)} 件`
                      )}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
      <p className="text-[12px] text-muted-foreground">{defaultReason(maps, t)}</p>
    </div>
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
          {node.draws_points ? (
            <span className="rounded-sm bg-warning-surface px-1.5 py-0.5 text-[11px] text-warning-foreground">
              {t("point layer", "ポイント")}
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
