import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  placementScope,
  type AdjustmentMode,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";

type Props = {
  state: PlacementState;
  mode: AdjustmentMode;
};

/** Names the floors the neighbouring placement controls will change. */
export function PlacementScopeNote({ state, mode }: Props) {
  const { t } = useUiLanguage();
  const scope = placementScope(state, mode);
  if (scope.labels.length === 0) return null;
  const [only] = scope.labels;
  return (
    <p data-testid="placement-scope" className="text-xs leading-4 text-muted-foreground">
      {scope.floorOnly
        ? t(`Editing ${only} only`, `${only}のみ編集中`)
        : t(
            `Editing linked levels: ${scope.labels.join(", ")}`,
            `リンク中のフロアを編集中：${scope.labels.join("、")}`
          )}
    </p>
  );
}
