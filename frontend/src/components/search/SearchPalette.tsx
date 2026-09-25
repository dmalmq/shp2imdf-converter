import { Search } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { fetchProjects, type ProjectSummary } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { toHubProject } from "../../lib/hub";
import { buildItems, stationFloorItems } from "../../lib/search/items";
import { KIND_ORDER, search, type ResultGroup } from "../../lib/search/match";
import { parse } from "../../lib/search/parse";
import { preview as previewOf, type PreviewContext } from "../../lib/search/preview";
import { floorRefs, levelRefs, wizardFloors, type ChangeCommand } from "../../lib/search/source";
import type { Command, Completion, FloorRef, Preview, SearchItem, SearchKind } from "../../lib/search/types";
import { useAppStore } from "../../store/useAppStore";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import {
  NEW_PROJECT_PATH,
  projectPath,
  stageReachable,
  stationName,
  type Bilingual,
  type ShapefileStageId
} from "../shell/stages";
import { useCheckSource } from "./SearchContext";

type T = (en: string, ja: string) => string;

/** A composition's confirming Enter can arrive just after compositionend, with isComposing already false. */
const COMPOSITION_ENTER_MS = 100;

const KIND_CHIP: Record<SearchKind | "help", Bilingual> = {
  station: { en: "Station", ja: "駅" },
  floor: { en: "Floor", ja: "フロア" },
  issue: { en: "Issue", ja: "課題" },
  file: { en: "File", ja: "ファイル" },
  action: { en: "Action", ja: "操作" },
  help: { en: "Help", ja: "ヘルプ" }
};

const GROUP_NAME: Record<SearchKind, Bilingual> = {
  station: { en: "Stations", ja: "駅" },
  floor: { en: "Floors", ja: "フロア" },
  issue: { en: "Issues", ja: "課題" },
  file: { en: "Files", ja: "ファイル" },
  action: { en: "Actions", ja: "操作" }
};

type Option = { id: string; item?: SearchItem; completion?: Completion };

type Section = { key: string; title: Bilingual; aside?: Bilingual; options: Option[] };

const STALE_NOTICE: Bilingual = {
  en: "This changed since you looked; here it is again.",
  ja: "確認の後に変更がありました。最新の内容を表示しています。"
};

function onMap(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".maplibregl-map") !== null;
}

/** Stops the click that follows a pointer-down which only closed the panel, so the map does not also select. */
function swallowNextClick() {
  const stop = (event: Event) => {
    event.stopPropagation();
    event.preventDefault();
    done();
  };
  const timer = window.setTimeout(() => done(), 1000);
  function done() {
    window.clearTimeout(timer);
    window.removeEventListener("click", stop, true);
  }
  window.addEventListener("click", stop, true);
}

export function SearchPalette() {
  const { t, uiLanguage, setUiLanguage } = useUiLanguage();
  const navigate = useNavigate();
  const check = useCheckSource();
  const sessionId = useAppStore((s) => s.sessionId);
  const loadedSessionId = useAppStore((s) => s.loadedSessionId);
  const storeFiles = useAppStore((s) => s.files);
  const wizardState = useAppStore((s) => s.wizardState);
  const importProfile = useAppStore((s) => s.importProfile);
  const currentScreen = useAppStore((s) => s.currentScreen);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [allStations, setAllStations] = useState(false);
  const [notice, setNotice] = useState<Bilingual | null>(null);
  const [applying, setApplying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const compositionEnd = useRef(-Infinity);
  const lastCheckFloors = useRef<{ sessionId: string; floors: FloorRef[] } | null>(null);
  const listId = useId();
  const deferredQuery = useDeferredValue(query);

  const files = loadedSessionId === sessionId ? storeFiles : [];
  const summary = projects.find((project) => project.id === sessionId) ?? null;
  const station = sessionId ? summary?.name?.trim() || stationName(wizardState, files) : null;

  const checkFloors = useMemo(
    () => (check ? floorRefs(check.snapshot.features, check.snapshot.floors) : null),
    [check]
  );
  useEffect(() => {
    if (check && checkFloors) lastCheckFloors.current = { sessionId: check.snapshot.sessionId, floors: checkFloors };
  }, [check, checkFloors]);
  const floors = useMemo(() => {
    if (checkFloors) return checkFloors;
    const last = lastCheckFloors.current;
    if (last && last.sessionId === sessionId) return last.floors;
    return sessionId ? wizardFloors(wizardState) : [];
  }, [checkFloors, sessionId, wizardState]);
  const levels = useMemo(() => (check && checkFloors ? levelRefs(check.snapshot.features, checkFloors) : []), [check, checkFloors]);
  const stations = useMemo(
    () => projects.map((project) => ({ projectId: project.id, name: project.name?.trim() ?? "" })).filter((item) => item.name),
    [projects]
  );
  const lexicon = useMemo(() => ({ floors, levels, stations }), [floors, levels, stations]);

  const stagePath = useCallback(
    (stage: ShapefileStageId): string | null => {
      if (!sessionId) return null;
      const reviewReached =
        currentScreen === "review" || summary?.stage === "check" || summary?.stage === "deliver" || check !== null;
      const profile = importProfile === "imdf_shapefile" ? "imdf_shapefile" : "standard";
      return stageReachable(stage, { importProfile: profile, reviewReached }) ? projectPath(sessionId, stage) : null;
    },
    [sessionId, currentScreen, summary, check, importProfile]
  );

  const context: PreviewContext = useMemo(
    () => ({
      check: check?.snapshot ?? null,
      stagePath,
      stationPath: (id, floor) => {
        if (floor) return `${projectPath(id, "check")}?floor=${encodeURIComponent(floor)}`;
        const found = projects.find((project) => project.id === id);
        return found ? toHubProject(found).href : projectPath(id, "check");
      },
      floorPath: (label) => {
        const to = stagePath("check");
        return to ? `${to}?floor=${encodeURIComponent(label)}` : null;
      }
    }),
    [check, stagePath, projects]
  );

  const items = useMemo(
    () =>
      buildItems({
        projects,
        sessionId,
        station,
        files,
        floors,
        check,
        uiLanguage,
        setLanguage: setUiLanguage,
        floorPath: context.floorPath,
        deliverPath: stagePath("deliver") ?? stagePath("check"),
        bringInPath: sessionId ? projectPath(sessionId, "bring-in") : NEW_PROJECT_PATH
      }),
    [projects, sessionId, station, files, floors, check, uiLanguage, setUiLanguage, context, stagePath]
  );

  const parsed = useMemo(() => parse(deferredQuery, lexicon), [deferredQuery, lexicon]);
  const preview: Preview | null = useMemo(
    () => (parsed.mode === "command" ? previewOf(parsed.command, context) : null),
    [parsed, context]
  );
  const results = useMemo(() => {
    if (parsed.mode !== "search" || !deferredQuery.trim()) return null;
    const found = search([...items.all, ...stationFloorItems(deferredQuery, projects, sessionId)], deferredQuery);
    return allStations ? { ...found, groups: found.groups.filter((group) => group.kind === "station") } : found;
  }, [parsed, deferredQuery, items, allStations, projects, sessionId]);

  const sections: Section[] = useMemo(() => {
    const asOptions = (list: SearchItem[]) => list.map((item) => ({ id: item.id, item }));
    if (!query.trim()) {
      const next: Section[] = [];
      if (items.nextFix) {
        next.push({
          key: "next",
          title: { en: "Next fix", ja: "次の修正" },
          aside:
            station && summary?.blockers
              ? { en: `${station} · ${summary.blockers} things before you can deliver`, ja: `${station} · 書き出し前に ${summary.blockers} 件` }
              : undefined,
          options: asOptions([items.nextFix])
        });
      }
      if (items.recents.length > 0) {
        next.push({ key: "recent", title: { en: "Recent stations", ja: "最近の駅" }, options: asOptions(items.recents) });
      }
      next.push({ key: "actions", title: { en: "Things you can do", ja: "できること" }, options: asOptions(items.actions) });
      return next;
    }
    if (parsed.mode === "search") {
      return (results?.groups ?? []).map((group: ResultGroup) => ({
        key: group.kind,
        title: GROUP_NAME[group.kind],
        aside:
          group.kind === "issue"
            ? mustFixAside(group)
            : group.total > group.items.length
              ? { en: `${group.items.length} of ${group.total}`, ja: `${group.total} 件中 ${group.items.length} 件` }
              : undefined,
        options: asOptions(group.items)
      }));
    }
    if (parsed.mode === "command") {
      const alternatives = alternativesFor(parsed.command, items.all);
      return alternatives.length > 0
        ? [{ key: "alt", title: { en: "Or did you mean", ja: "もしかして" }, options: asOptions(alternatives) }]
        : [];
    }
    const completions = parsed.completions.map((completion) => ({ id: `complete:${completion.input}`, completion }));
    const title: Bilingual =
      parsed.mode === "ambiguous"
        ? { en: `Which “${parsed.text}”?`, ja: `どの「${parsed.text}」ですか？` }
        : parsed.mode === "unknown"
          ? { en: `Nothing is called “${parsed.text}”`, ja: `「${parsed.text}」は見つかりません` }
          : { en: "Complete the command", ja: "コマンドの続き" };
    return [{ key: "complete", title, options: completions }];
  }, [query, items, parsed, results, station, summary]);

  const options = useMemo(() => sections.flatMap((section) => section.options), [sections]);
  const activeIndex = options.length === 0 ? -1 : Math.min(active, options.length - 1);
  const activeOption = activeIndex >= 0 ? options[activeIndex] : null;

  useEffect(() => {
    setActive(0);
    setNotice(null);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetchProjects("shapefiles").then(
      (response) => live && setProjects(response.projects),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [open]);

  const highlight = open && preview?.kind === "change" ? preview.highlight : null;
  useEffect(() => {
    if (!check) return;
    check.showPreview(highlight);
    return () => check.showPreview(null);
  }, [check, highlight]);

  const openPanel = useCallback(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== inputRef.current) returnFocus.current = focused;
    setOpen(true);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const close = useCallback((restore = true) => {
    setOpen(false);
    if (restore && returnFocus.current?.isConnected) returnFocus.current.focus();
    else inputRef.current?.blur();
    returnFocus.current = null;
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopPropagation();
        openPanel();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [openPanel]);

  const finish = () => {
    setQuery("");
    close(false);
  };

  const runItem = (item: SearchItem) => {
    const run = item.run;
    if (run.kind === "disabled") return;
    if (run.kind === "command") {
      setQuery(run.text);
      inputRef.current?.focus();
      return;
    }
    if (run.kind === "navigate") navigate(run.to);
    else run.invoke();
    finish();
  };

  const runOption = (option: Option) => {
    if (option.item) runItem(option.item);
    else if (option.completion) {
      setQuery(option.completion.input);
      inputRef.current?.focus();
    }
  };

  const follow = (target: Extract<Preview, { kind: "go" }>["target"]) => {
    if (target.kind === "route") navigate(target.to);
    else if (target.kind === "floor") check?.showFloor(target.label);
    else check?.showLevel(target.id);
    finish();
  };

  const apply = async () => {
    if (!check || parsed.mode !== "command" || preview?.kind !== "change" || applying) return;
    if (preview.basis !== check.snapshot.contentRev) {
      setNotice(STALE_NOTICE);
      return;
    }
    setApplying(true);
    try {
      const outcome = await check.apply(parsed.command as ChangeCommand, preview.basis);
      if (outcome.kind === "done") finish();
      else if (outcome.kind === "stale") setNotice(STALE_NOTICE);
    } finally {
      setApplying(false);
    }
  };

  const cancelCommand = parsed.mode !== "search" && query.trim() !== "";

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const justComposed = performance.now() - compositionEnd.current < COMPOSITION_ENTER_MS;
    if ((event.key === "Enter" || event.key === "Tab") && justComposed) {
      event.preventDefault();
      compositionEnd.current = -Infinity;
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (open && cancelCommand) setQuery("");
      else close();
      return;
    }
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "Enter") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + options.length) % options.length);
      return;
    }
    if (event.key === "Tab") {
      const completion = parsed.mode !== "search" && parsed.mode !== "command" ? parsed.completions[0] : undefined;
      if (completion) {
        event.preventDefault();
        setQuery(completion.input);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (preview?.kind === "change") void apply();
      else if (preview?.kind === "go") follow(preview.target);
      else if (activeOption) runOption(activeOption);
    }
  };

  const count = results?.count ?? 0;
  const status = !open
    ? ""
    : preview
      ? t(preview.sentence.en, preview.sentence.ja)
      : results
        ? count === 0
          ? t("Nothing matches", "一致するものはありません")
          : t(`${count} matches`, `${count} 件一致`)
        : "";

  const optionId = (index: number) => `${listId}-option-${index}`;
  let flatIndex = -1;

  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close(false))}>
      <PopoverAnchor asChild>
        <div
          ref={anchorRef}
          data-slot="search"
          className={cn(
            "flex h-[38px] min-w-0 flex-1 items-center gap-2.5 rounded-lg border bg-background pl-3 pr-2 transition-colors",
            open ? "border-primary ring-1 ring-primary" : "border-border"
          )}
          onMouseDown={(event) => {
            if (event.target !== inputRef.current) {
              event.preventDefault();
              openPanel();
            }
          }}
        >
          <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          {cancelCommand ? (
            <span className="shrink-0 rounded bg-foreground px-1.5 py-px font-mono text-[10px] font-medium uppercase leading-[14px] tracking-[0.06em] text-background">
              {t("Command", "コマンド")}
            </span>
          ) : null}
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && activeIndex >= 0 && !preview ? optionId(activeIndex) : undefined}
            aria-label={t("Search and commands", "検索とコマンド")}
            placeholder={t(
              "Search stations, floors, issues, files, or type a command",
              "駅・フロア・課題・ファイルを検索、またはコマンドを入力"
            )}
            value={query}
            spellCheck={false}
            autoComplete="off"
            className={cn(
              "h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground",
              cancelCommand && "font-mono text-[13px]"
            )}
            onChange={(event) => {
              setQuery(event.target.value);
              if (!open) openPanel();
            }}
            onFocus={() => {
              if (!open) setOpen(true);
            }}
            onKeyDown={onKeyDown}
            onCompositionEnd={() => {
              compositionEnd.current = performance.now();
            }}
          />
          <kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-px font-mono text-[10.5px] leading-[14px] text-muted-foreground">
            {open ? "Esc" : "Ctrl K"}
          </kbd>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="flex max-h-[calc(100vh-96px)] w-[min(700px,calc(100vw-2rem))] flex-col gap-0.5 rounded-xl p-2 pb-0 shadow-lg"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => {
          const target = event.detail.originalEvent.target;
          if (target instanceof Node && anchorRef.current?.contains(target)) {
            event.preventDefault();
            return;
          }
          if (onMap(target)) swallowNextClick();
        }}
        onFocusOutside={(event) => {
          if (event.target instanceof Node && anchorRef.current?.contains(event.target)) event.preventDefault();
        }}
      >
        <span role="status" className="sr-only">
          {status}
        </span>

        {results && station && check ? (
          <div className="flex items-center gap-1.5 px-3 pb-1 pt-1.5 text-xs text-muted-foreground">
            <span>{t("Looking in", "検索範囲")}</span>
            <button
              type="button"
              aria-pressed={!allStations}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setAllStations(false)}
              className={cn("rounded-[5px] px-2 py-0.5", !allStations ? "bg-accent font-medium text-primary" : "bg-muted text-foreground/80")}
            >
              {station}
            </button>
            <button
              type="button"
              aria-pressed={allStations}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setAllStations(true)}
              className={cn("rounded-[5px] px-2 py-0.5", allStations ? "bg-accent font-medium text-primary" : "bg-muted text-foreground/80")}
            >
              {t("All stations", "すべての駅")}
            </button>
            <span className="flex-1" />
            <span className="text-[11.5px]">{t(`${count} matches`, `${count} 件一致`)}</span>
          </div>
        ) : null}

        <div className="min-h-0 overflow-y-auto">
          {preview ? (
            <CommandPreview
              preview={preview}
              command={parsed.mode === "command" ? parsed.command : null}
              notice={notice}
              applying={applying}
              t={t}
              onApply={() => void apply()}
              onCancel={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              onGo={follow}
            />
          ) : null}

          <div id={listId} role="listbox" aria-label={t("Results", "結果")}>
            {sections.map((section) => {
              const headingId = `${listId}-${section.key}`;
              return (
                <div key={section.key} role="group" aria-labelledby={headingId}>
                  <div className="flex items-center px-3 pb-1 pt-2.5">
                    <span
                      id={headingId}
                      className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
                    >
                      {t(section.title.en, section.title.ja)}
                    </span>
                    <span className="flex-1" />
                    {section.aside ? (
                      <span className="text-[11.5px] text-muted-foreground">{t(section.aside.en, section.aside.ja)}</span>
                    ) : null}
                  </div>
                  {section.options.map((option) => {
                    flatIndex += 1;
                    const index = flatIndex;
                    return (
                      <ResultRow
                        key={option.id}
                        id={optionId(index)}
                        option={option}
                        active={!preview && index === activeIndex}
                        t={t}
                        onHover={() => setActive(index)}
                        onRun={() => runOption(option)}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-1 flex items-center gap-3 border-t border-border px-3 py-2.5 text-[11.5px] text-muted-foreground">
          <span className="min-w-0 truncate">{footerText(query, parsed.mode, results?.empty ?? [], items, t)}</span>
          <span className="flex-1" />
          <span className="shrink-0">
            {parsed.mode === "search"
              ? t("↑ ↓ to move · Enter to open · keys optional", "↑ ↓ 移動 · Enter 開く · キー操作は任意")
              : t("Tab completes · keys optional", "Tab で補完 · キー操作は任意")}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function mustFixAside(group: ResultGroup): Bilingual | undefined {
  const blocking = group.items.filter((item) => item.detail.en.endsWith("blocks delivery")).length;
  return blocking > 0 ? { en: `${blocking} must fix`, ja: `要修正 ${blocking} 件` } : undefined;
}

function alternativesFor(command: Command, all: readonly SearchItem[]): SearchItem[] {
  if (command.verb !== "assign") return [];
  const go: SearchItem = {
    id: `alt:go:${command.level.id}`,
    kind: "action",
    label: { en: `Go to ${command.level.name}`, ja: `${command.level.name}へ移動` },
    detail: { en: "Just look at it — changes nothing", ja: "見るだけ — 何も変更しません" },
    run: { kind: "command", text: `go ${command.level.name}` },
    terms: []
  };
  const floor = all.find((item) => item.id === `floor:${command.to.label}`);
  return floor ? [go, floor] : [go];
}

function footerText(
  query: string,
  mode: string,
  empty: readonly SearchKind[],
  items: ReturnType<typeof buildItems>,
  t: T
): string {
  if (!query.trim()) {
    const station = items.recents[0]?.label.en;
    const file = items.all.find((item) => item.kind === "file")?.label.en;
    const tries = [station ? `${station} 1F` : null, "overlap", file ?? null, "export"].filter(Boolean).join(" · ");
    return t(`Try ${tries}`, `例：${tries}`);
  }
  if (mode === "search") {
    const names = KIND_ORDER.filter((kind) => empty.includes(kind)).map((kind) => GROUP_NAME[kind]);
    if (names.length === 0) return "";
    const en = names.length === 1 ? names[0].en : `${names.slice(0, -1).map((n) => n.en).join(", ")} or ${names[names.length - 1].en}`;
    const ja = names.map((n) => n.ja).join("・");
    return t(`Nothing in ${en} matches “${query.trim()}”.`, `${ja}に「${query.trim()}」と一致するものはありません。`);
  }
  return t(
    "Typed commands and buttons do the same thing, and both can be undone.",
    "コマンドとボタンは同じ操作で、どちらも元に戻せます。"
  );
}

function ResultRow({
  id,
  option,
  active,
  t,
  onHover,
  onRun
}: {
  id: string;
  option: Option;
  active: boolean;
  t: T;
  onHover: () => void;
  onRun: () => void;
}) {
  const item = option.item;
  const chip = item ? KIND_CHIP[item.tone ?? item.kind] : null;
  const label = item?.label ?? option.completion!.label;
  const detail = item?.detail ?? option.completion!.detail;
  const disabled = item?.run.kind === "disabled";
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      title={item?.run.kind === "disabled" ? t(item.run.reason.en, item.run.reason.ja) : undefined}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onHover}
      onClick={onRun}
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2",
        active && "bg-accent",
        disabled && "cursor-default opacity-60"
      )}
    >
      <span className="flex w-[70px] shrink-0">
        {chip ? (
          <span
            className={cn(
              "rounded-[3px] px-1.5 py-px font-mono text-[9.5px] font-medium uppercase tracking-[0.06em]",
              item?.kind === "issue" ? "bg-destructive-muted text-destructive" : "bg-muted text-muted-foreground"
            )}
          >
            {t(chip.en, chip.ja)}
          </span>
        ) : (
          <span className="rounded-[3px] bg-muted px-1.5 py-px font-mono text-[9.5px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
            {t("Tab", "Tab")}
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-px">
        <span className={cn("truncate text-[13.5px] font-medium text-foreground", option.completion && "font-mono text-[13px]")}>
          {option.completion ? option.completion.input : t(label.en, label.ja)}
        </span>
        <span className="truncate text-xs text-muted-foreground">{t(detail.en, detail.ja)}</span>
      </span>
      <span className="flex-1" />
      {item?.badge ? <span className="shrink-0 text-xs text-destructive">{t(item.badge.en, item.badge.ja)}</span> : null}
      {item?.hint ? (
        <span className={cn("shrink-0 text-xs", active ? "font-medium text-primary" : "text-muted-foreground")}>
          {t(item.hint.en, item.hint.ja)}
        </span>
      ) : null}
      {active ? (
        <kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">
          Enter
        </kbd>
      ) : null}
    </div>
  );
}

function Chip({ children, tone = "info" }: { children: React.ReactNode; tone?: "verb" | "info" }) {
  return (
    <span
      className={cn(
        "rounded-[5px] px-2 py-0.5 text-xs",
        tone === "verb" ? "bg-foreground font-mono font-medium text-background" : "bg-info-muted font-medium text-info"
      )}
    >
      {children}
    </span>
  );
}

function understoodAs(command: Command, t: T): React.ReactNode {
  if (command.verb === "assign") {
    return (
      <>
        <Chip tone="verb">{command.alias}</Chip>
        <Chip>
          {t(
            `level ${command.level.name} (now on ${command.level.floor.label})`,
            `レベル ${command.level.name}（現在 ${command.level.floor.label}）`
          )}
        </Chip>
        <span aria-hidden="true">→</span>
        <Chip>{t(`floor ${command.to.label}`, `フロア ${command.to.label}`)}</Chip>
        {command.outdoor !== "keep" ? (
          <>
            <span aria-hidden="true">+</span>
            <Chip>
              {command.outdoor === "set" ? t("mark as outdoor", "屋外にする") : t("mark as indoor", "屋内にする")}
            </Chip>
          </>
        ) : null}
      </>
    );
  }
  if (command.verb === "fix") {
    return (
      <>
        <Chip tone="verb">fix</Chip>
        <Chip>{t("overlaps", "重なり")}</Chip>
      </>
    );
  }
  const place = command.place;
  const target =
    place.kind === "station"
      ? `${place.station.name}${place.floor ? ` · ${place.floor}` : ""}`
      : place.kind === "floor"
        ? place.floor.label
        : place.kind === "level"
          ? place.level.name
          : place.stage;
  return (
    <>
      <Chip tone="verb">go</Chip>
      <Chip>{target}</Chip>
    </>
  );
}

function CommandPreview({
  preview,
  command,
  notice,
  applying,
  t,
  onApply,
  onCancel,
  onGo
}: {
  preview: Preview;
  command: Command | null;
  notice: Bilingual | null;
  applying: boolean;
  t: T;
  onApply: () => void;
  onCancel: () => void;
  onGo: (target: Extract<Preview, { kind: "go" }>["target"]) => void;
}) {
  return (
    <section aria-label={t("What this command does", "このコマンドの内容")} className="flex flex-col">
      {command ? (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-0.5 pt-2 text-xs text-muted-foreground">
          <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em]">
            {t("Understood as", "解釈")}
          </span>
          {understoodAs(command, t)}
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5 px-3 pb-1.5 pt-2.5">
        <p className="font-display text-xl font-semibold leading-[26px] text-foreground">
          {t(preview.sentence.en, preview.sentence.ja)}
        </p>
        {preview.kind === "change" ? (
          <p className="text-[13px] leading-5 text-foreground/80">{t(preview.consequence.en, preview.consequence.ja)}</p>
        ) : null}
        {preview.kind === "unavailable" ? (
          <p className="text-[13px] leading-5 text-muted-foreground">{t(preview.reason.en, preview.reason.ja)}</p>
        ) : null}
      </div>
      {preview.kind === "change" && preview.rows.length > 0 ? (
        <div className="px-3 pt-1">
          <dl className="flex flex-col rounded-lg bg-background px-1 py-2 text-[12.5px]">
            {preview.rows.map((row) => (
              <div key={row.field.en} className="flex items-center gap-2.5 px-3 py-[5px]">
                <dt className="w-16 shrink-0 text-muted-foreground">{t(row.field.en, row.field.ja)}</dt>
                <dd className="flex items-center gap-2.5">
                  <span className="font-mono font-medium text-muted-foreground line-through">{row.before}</span>
                  <span aria-hidden="true" className="text-muted-foreground">→</span>
                  <span className="sr-only">{t("becomes", "から")}</span>
                  <span className="font-mono font-medium text-primary">{row.after}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      {preview.kind === "change" ? (
        <p className="px-3 pt-1 text-[12.5px] text-muted-foreground">{t(preview.followUp.en, preview.followUp.ja)}</p>
      ) : null}
      {notice ? (
        <p role="alert" className="mx-3 mt-2 rounded-md bg-warning-surface px-3 py-1.5 text-xs text-warning-foreground">
          {t(notice.en, notice.ja)}
        </p>
      ) : null}
      {preview.kind === "change" || preview.kind === "go" ? (
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <Button
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => (preview.kind === "go" ? onGo(preview.target) : onApply())}
            disabled={applying}
          >
            {preview.kind === "go" ? t("Go", "移動") : t("Apply", "適用")}
            <kbd className="rounded bg-white/15 px-1.5 py-px font-mono text-[10.5px] font-medium">Enter</kbd>
          </Button>
          <Button variant="outline" onMouseDown={(event) => event.preventDefault()} onClick={onCancel}>
            {t("Cancel", "キャンセル")}
            <kbd className="rounded border border-border bg-muted px-1.5 py-px font-mono text-[10.5px] font-medium text-muted-foreground">
              Esc
            </kbd>
          </Button>
        </div>
      ) : null}
      <div className="h-px bg-border" />
    </section>
  );
}
