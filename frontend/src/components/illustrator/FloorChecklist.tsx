import type { PlacementState } from "../../hooks/useIllustratorPlacement";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import type { FloorStatus } from "../../lib/floorStatus";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";

type Props = {
  state: PlacementState;
  statuses: Map<string, FloorStatus>;
  onReview: (label: string) => void;
};

type T = (en: string, ja: string) => string;

export function statusDetail(status: FloorStatus, t: T): string | null {
  if (status.kind === "aligned") {
    const { basis } = status;
    if (basis.kind === "floor") return t(`Matched to ${basis.floor}`, `${basis.floor}に合わせました`);
    if (basis.kind === "reference") return t("Matched to reference data", "参照データに合わせました");
    return t(
      `Fitted to ${basis.pointIds.length} pairs on ${basis.floor}`,
      `${basis.floor}の対応点 ${basis.pointIds.length} 組で合わせました`
    );
  }
  switch (status.reason) {
    case "moved":
      return t("Moved since it was aligned", "位置合わせの後に動かされました");
    case "reference-moved":
      return t("The floor it was matched to has moved", "合わせた先のフロアが動きました");
    case "points-changed":
      return t("Its matching pairs changed", "対応点が変わりました");
    default:
      return null;
  }
}

/** Every floor with its status, and a way back to the ones that need work. */
export function FloorChecklist({ state, statuses, onReview }: Props) {
  const { t } = useUiLanguage();
  return (
    <ul
      aria-label={t("Floor status", "フロアの状態")}
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      {state.floors.map((floor, index) => {
        const status = statuses.get(floor.label) ?? { kind: "needs-alignment", reason: "never" };
        const aligned = status.kind === "aligned";
        const detail = statusDetail(status, t);
        return (
          <li
            key={floor.label}
            data-floor-status={status.kind}
            className={cn("flex items-center gap-2 px-3 py-2", index > 0 && "border-t border-border")}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-2">
                <span className="text-[13px] font-medium leading-[18px] text-foreground">{floor.label}</span>
                <Badge variant={aligned ? "success" : "warning"}>
                  {aligned ? t("Aligned", "位置合わせ済み") : t("Needs alignment", "位置合わせが必要")}
                </Badge>
              </span>
              {detail ? <span className="text-xs leading-4 text-muted-foreground">{detail}</span> : null}
            </span>
            {aligned ? null : (
              <Button size="sm" variant="outline" onClick={() => onReview(floor.label)}>
                {t(`Review ${floor.label}`, `${floor.label}を確認`)}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
