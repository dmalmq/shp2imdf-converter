import { Check, ChevronRight } from "lucide-react";
import { useState } from "react";

import {
  minControlPoints,
  type FloorPlacement,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { floorFit, recommendedAlignment, type CurrentReferences, type FloorStatus } from "../../lib/floorStatus";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "@/lib/utils";
import { statusDetail } from "./floorStatusCopy";
import { PlacementLibrary } from "./PlacementLibrary";
import { RelinkControl } from "./TransformPanel";

type Props = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  statuses: Map<string, FloorStatus>;
  references: CurrentReferences;
  /** Select the floor and open the method it needs. */
  onAlign: (label: string) => void;
  artworkBounds: [number, number, number, number];
  /** Things worth knowing that do not block delivery. */
  notes: string[];
};

type Todo = { lead: FloorPlacement; followers: string[] };

type T = (en: string, ja: string) => string;

/**
 * Floors still to align, in the order to do them. Linked floors move as one,
 * so they are one to-do led by the first of them; the active floor goes first.
 */
function todos(state: PlacementState, statuses: Map<string, FloorStatus>): Todo[] {
  const open = state.floors.filter((floor) => statuses.get(floor.label)?.kind !== "aligned");
  const grouped = open.filter((floor) => floor.linked && !floor.pinned && state.floors.length > 1);
  const list: Todo[] = open
    .filter((floor) => !grouped.includes(floor))
    .map((floor) => ({ lead: floor, followers: [] }));
  if (grouped.length > 0) {
    const lead = grouped.find((floor) => floor.label === state.activeFloorLabel) ?? grouped[0];
    list.push({ lead, followers: grouped.filter((floor) => floor !== lead).map((floor) => floor.label) });
  }
  const order = (todo: Todo) =>
    todo.lead.label === state.activeFloorLabel ? -1 : state.floors.indexOf(todo.lead);
  return list.sort((a, b) => order(a) - order(b));
}

function todoCopy(state: PlacementState, status: FloorStatus | undefined, todo: Todo, t: T) {
  const { lead, followers } = todo;
  const label = lead.label;
  const recommended = recommendedAlignment(state, lead);
  if (recommended.kind === "match-floor") {
    return {
      title: t(`Align ${label} to ${recommended.target}`, `${label}を${recommended.target}に合わせる`),
      body: t(
        `${label} did not stack with the other pages. Match it to ${recommended.target} by an outline or by two areas.`,
        `${label}は他のページと重なりませんでした。外周か2つの範囲で${recommended.target}に合わせてください。`
      ),
      action: t(`Align ${label} to ${recommended.target}`, `${label}を${recommended.target}に合わせる`)
    };
  }
  const reason = status?.kind === "needs-alignment" ? statusDetail(status, t) : null;
  const pairs = lead.controlPoints.length;
  const needed = minControlPoints(state);
  const body =
    reason ??
    (pairs > 0
      ? t(
          `Click a corner on the plan, then the same corner on the map. ${pairs} of ${needed} in.`,
          `図面の角をクリックし、地図上の同じ角をクリックします。${needed} 組中 ${pairs} 組。`
        )
      : t(
          `Add ${needed} matching pairs, or match its outline to Station_pg.`,
          `対応点を ${needed} 組追加するか、外周を Station_pg に合わせてください。`
        ));
  const linkedNote =
    followers.length > 0
      ? t(
          ` ${followers.join(", ")} ${followers.length === 1 ? "is" : "are"} linked to it, so one group fit aligns ${followers.length === 1 ? "it" : "them"} too.`,
          ` ${followers.join("、")}はリンクしているので、グループで合わせると一緒に揃います。`
        )
      : "";
  return {
    title: reason ? t(`Align ${label} again`, `${label}をもう一度合わせる`) : t(`Align ${label}`, `${label}を合わせる`),
    body: body + linkedNote,
    action: pairs > 0 && pairs < needed ? t("Add matching pair", "対応点を追加") : t(`Align ${label}`, `${label}を合わせる`)
  };
}

function frameTag(floor: FloorPlacement, state: PlacementState, t: T): string | null {
  if (state.floors.length < 2) return null;
  if (floor.pinned) return t("pinned", "固定");
  return floor.linked ? t("linked", "リンク") : t("own frame", "個別");
}

/** The left column of Place on map: what is left before Deliver, and what is done. */
export function PlacementTodo({ state, dispatch, statuses, references, onAlign, artworkBounds, notes }: Props) {
  const { t } = useUiLanguage();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const total = state.floors.length;
  const aligned = state.floors.filter((floor) => statuses.get(floor.label)?.kind === "aligned");
  const list = todos(state, statuses);
  const next = list[0]?.lead.label;

  return (
    <aside
      aria-label={t("Before you can deliver", "書き出しの前に")}
      className="flex h-full min-h-0 w-[390px] shrink-0 flex-col gap-5 overflow-auto border-r border-border bg-background px-7 py-7"
    >
      <div className="flex flex-col gap-3">
        <h2 className="font-display text-[26px] font-semibold leading-8 text-foreground">
          {t("Before you can deliver", "書き出しの前に")}
        </h2>
        <div className="flex gap-1.5" aria-hidden="true">
          {state.floors.map((floor) => (
            <span
              key={floor.label}
              className={cn(
                "h-1.5 flex-1 rounded-full",
                statuses.get(floor.label)?.kind === "aligned" ? "bg-primary" : "bg-muted"
              )}
            />
          ))}
        </div>
        <p data-testid="todo-summary" className="text-[13px] leading-5 text-muted-foreground">
          {aligned.length === total
            ? t(`All ${total} floors aligned`, `全 ${total} フロア位置合わせ済み`)
            : t(
                `${aligned.length} of ${total} floors aligned · ${total - aligned.length} left${next ? ` · ${next} is next` : ""}`,
                `${total} フロア中 ${aligned.length} 位置合わせ済み · 残り ${total - aligned.length}${next ? ` · 次は${next}` : ""}`
              )}
        </p>
      </div>

      {list.length > 0 ? (
        <ol className="flex flex-col gap-3">
          {list.map((todo, index) => {
            const copy = todoCopy(state, statuses.get(todo.lead.label), todo, t);
            const first = index === 0;
            const tag = frameTag(todo.lead, state, t);
            const relinkable = !todo.lead.linked && !todo.lead.pinned && state.floors.length > 1;
            return (
              <li
                key={todo.lead.label}
                data-todo={todo.lead.label}
                className={cn(
                  "flex flex-col gap-3 rounded-xl bg-card p-4",
                  first ? "border-[1.5px] border-artwork" : "border border-border"
                )}
              >
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                      first ? "bg-artwork text-artwork-foreground" : "bg-muted text-muted-foreground"
                    )}
                  >
                    {index + 1}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="text-[15px] font-semibold leading-5 text-foreground">{copy.title}</p>
                    <p className="text-[13px] leading-[18px] text-muted-foreground">{copy.body}</p>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 font-mono text-[11px] leading-4",
                      todo.lead.pinned || !todo.lead.linked
                        ? "border border-dashed border-artwork text-artwork"
                        : "bg-artwork-muted text-artwork"
                    )}
                  >
                    {todo.followers.length > 0
                      ? t(`${todo.followers.length + 1} linked`, `${todo.followers.length + 1} リンク`)
                      : (tag ?? todo.lead.label)}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 pl-[34px]">
                  <Button
                    size="sm"
                    variant={first ? "secondary" : "outline"}
                    className={cn(first && "bg-artwork-muted text-artwork hover:bg-artwork-muted/80")}
                    onClick={() => onAlign(todo.lead.label)}
                  >
                    {copy.action}
                  </Button>
                  {relinkable ? <RelinkControl state={state} label={todo.lead.label} dispatch={dispatch} references={references} /> : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}

      <Collapsible
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        className="rounded-xl border border-border bg-card p-4"
      >
        <CollapsibleTrigger className="flex w-full items-start justify-between gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="flex flex-col gap-1">
            <span className="text-[15px] font-semibold leading-5 text-foreground">
              {t("Save this placement", "この配置を保存")}
            </span>
            <span className="text-[13px] leading-[18px] text-muted-foreground">
              {t(
                "So the next drawing of this building can reapply it instead of aligning again.",
                "同じ建物の次の図面で、合わせ直さずに再利用できます。"
              )}
            </span>
          </span>
          <ChevronRight
            className={cn("mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform", libraryOpen && "rotate-90")}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <PlacementLibrary state={state} dispatch={dispatch} artworkBounds={artworkBounds} references={references} />
        </CollapsibleContent>
      </Collapsible>

      {aligned.length > 0 ? (
        <section className="flex flex-col gap-2">
          <p className="font-mono text-[11px] uppercase leading-[14px] tracking-[0.06em] text-muted-foreground">
            {t(`Done · ${aligned.length}`, `完了 · ${aligned.length}`)}
          </p>
          <ul className="flex flex-col gap-1.5">
            {aligned.map((floor) => {
              const rmse = floorFit(state, floor, references);
              return (
                <li key={floor.label} className="flex items-center gap-2 text-[13px] leading-5">
                  <Check
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 rounded-full bg-primary p-0.5 text-primary-foreground"
                    strokeWidth={3}
                  />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {rmse !== null
                      ? t(`${floor.label} aligned · RMSE ${rmse.toFixed(2)} m`, `${floor.label} 位置合わせ済み · RMSE ${rmse.toFixed(2)} m`)
                      : t(`${floor.label} aligned`, `${floor.label} 位置合わせ済み`)}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 rounded-sm text-[13px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onAlign(floor.label)}
                  >
                    {t("Review", "確認")}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {notes.length > 0 ? (
        <section className="flex flex-col gap-2 rounded-xl bg-warning-surface p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[13px] font-semibold leading-5 text-warning-foreground">
              {t(`Can wait · ${notes.length} ${notes.length === 1 ? "note" : "notes"}`, `後回しでよい · ${notes.length} 件`)}
            </p>
            <p className="text-xs leading-4 text-warning-foreground">{t("Won't block delivery", "書き出しは止めません")}</p>
          </div>
          {notes.map((note) => (
            <p key={note} className="text-[13px] leading-[18px] text-foreground">
              {note}
            </p>
          ))}
        </section>
      ) : null}
    </aside>
  );
}
