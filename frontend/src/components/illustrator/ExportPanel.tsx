import { useUiLanguage } from "../../hooks/useUiLanguage";
import type { ExportFormatsPayload } from "../../api/client";
import type { PlacementAction, PlacementState } from "../../hooks/useIllustratorPlacement";
import { Button } from "../ui";
import { PlacementLibrary } from "./PlacementLibrary";

type Props = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  artworkBounds: [number, number, number, number];
  crsChoices: { value: string; label: string }[];
  outputCrs: string;
  onOutputCrsChange: (value: string) => void;
  formats: ExportFormatsPayload;
  onFormatsChange: (formats: ExportFormatsPayload) => void;
  onExport: () => void;
  previewFeatures: number;
  totalFeatures: number;
  error: string | null;
};

/** Saving a placement for reuse, and emitting the georeferenced files. */
export function ExportPanel({
  state,
  dispatch,
  artworkBounds,
  crsChoices,
  outputCrs,
  onOutputCrsChange,
  formats,
  onFormatsChange,
  onExport,
  previewFeatures,
  totalFeatures,
  error
}: Props) {
  const { t } = useUiLanguage();

  return (
    <div className="space-y-4 text-sm">
      <PlacementLibrary state={state} dispatch={dispatch} artworkBounds={artworkBounds} />

      <section>
        <span className="text-xs font-medium">{t("Export", "書き出し")}</span>
        <select
          className="mt-1 w-full rounded-[var(--radius-md)] border px-2 py-1 text-sm"
          value={outputCrs}
          onChange={(event) => onOutputCrsChange(event.target.value)}
        >
          {crsChoices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        {(["geopackage", "shapefile", "qgis"] as const).map((key) => (
          <label key={key} className="mt-1 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={formats[key]}
              onChange={(event) => onFormatsChange({ ...formats, [key]: event.target.checked })}
            />
            {key}
          </label>
        ))}
        <Button className="mt-2 w-full" onClick={onExport}>
          {t("Export", "書き出し")}
        </Button>
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          {t(
            `Preview shows ${previewFeatures} of ${totalFeatures} shapes.`,
            `プレビューは ${totalFeatures} 図形中 ${previewFeatures} 件を表示。`
          )}
        </p>
        {error ? <p className="mt-2 text-xs text-[var(--color-error)]">{error}</p> : null}
      </section>
    </div>
  );
}
