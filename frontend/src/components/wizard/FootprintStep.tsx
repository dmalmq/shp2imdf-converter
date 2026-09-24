import { useCallback, useEffect, useRef, useState } from "react";

import { fetchFootprintPreview, type FootprintPreview, type FootprintWizardState } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../ui";
import { useAppStore } from "../../store/useAppStore";


type Props = {
  /** What the form shows: the unsaved draft if there is one, else the saved options. */
  footprint: FootprintWizardState;
  onChange: (payload: FootprintWizardState) => void;
};

const SVG_SIZE = 320;
const SVG_PAD = 16;

export function polygonsToSvgPaths(
  rings: number[][][],
  minX: number,
  minY: number,
  scale: number
): string {
  return rings
    .map((ring) => {
      const points = ring.map(
        ([x, y]) =>
          `${((x - minX) * scale + SVG_PAD).toFixed(1)},${(SVG_SIZE - ((y - minY) * scale + SVG_PAD)).toFixed(1)}`
      );
      return `M${points.join("L")}Z`;
    })
    .join("");
}


export function FootprintStep({ footprint: form, onChange }: Props) {
  const { t } = useUiLanguage();
  const sessionId = useAppStore((state) => state.sessionId);
  const [preview, setPreview] = useState<FootprintPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchPreview = useCallback(
    (state: FootprintWizardState) => {
      if (!sessionId) return;
      setLoadingPreview(true);
      fetchFootprintPreview(
        sessionId,
        state.method,
        state.footprint_buffer_m,
        state.venue_buffer_m,
        state.level_gap_fill_m
      )
        .then(setPreview)
        .catch(() => setPreview(null))
        .finally(() => setLoadingPreview(false));
    },
    [sessionId]
  );

  // Fetch on mount
  useEffect(() => {
    fetchPreview(form);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Debounced fetch on form change
  const updateForm = useCallback(
    (next: FootprintWizardState) => {
      onChange(next);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => fetchPreview(next), 300);
    },
    [fetchPreview, onChange]
  );

  // Compute SVG paths from preview data
  let footprintPath = "";
  let venuePath = "";
  if (preview?.units_bbox) {
    const [minX, minY, maxX, maxY] = preview.units_bbox;
    const dx = maxX - minX || 1e-6;
    const dy = maxY - minY || 1e-6;
    const scale = (SVG_SIZE - SVG_PAD * 2) / Math.max(dx, dy);

    if (preview.venue) {
      venuePath = polygonsToSvgPaths(preview.venue, minX, minY, scale);
    }
    if (preview.footprint) {
      footprintPath = polygonsToSvgPaths(preview.footprint, minX, minY, scale);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-5">

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        {/* Controls */}
        <div className="grid gap-4 self-start md:grid-cols-2 lg:grid-cols-1">
          <Field label={t("Footprint Method", "Footprint 生成方法")}>
            {(id) => (
              <Select
                value={form.method}
                onValueChange={(value) =>
                  updateForm({ ...form, method: value as FootprintWizardState["method"] })
                }
              >
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="union_buffer">
                    {t("Union + buffer (default)", "Union + バッファ（標準）")}
                  </SelectItem>
                  <SelectItem value="convex_hull">{t("Convex hull", "凸包")}</SelectItem>
                  <SelectItem value="concave_hull">{t("Concave hull", "凹包")}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </Field>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor="fp-footprint_buffer_m" className="text-[13px] font-medium leading-[18px] text-foreground">
                {t("Footprint buffer", "Footprint バッファ")}
              </label>
              <span className="font-mono text-[11px] leading-[14px] tracking-[0.02em] text-muted-foreground">
                {form.footprint_buffer_m.toFixed(1)} m
              </span>
            </div>
            <input
              id="fp-footprint_buffer_m"
              type="range"
              className="h-4 w-full accent-foreground"
              min={0}
              max={3}
              step={0.1}
              value={form.footprint_buffer_m}
              onChange={(event) =>
                updateForm({ ...form, footprint_buffer_m: Number(event.target.value) })
              }
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor="fp-level_gap_fill_m" className="text-[13px] font-medium leading-[18px] text-foreground">
                {t("Gap fill", "隙間埋め")}
              </label>
              <span className="font-mono text-[11px] leading-[14px] tracking-[0.02em] text-muted-foreground">
                {form.level_gap_fill_m.toFixed(2)} m
              </span>
            </div>
            <input
              id="fp-level_gap_fill_m"
              type="range"
              className="h-4 w-full accent-foreground"
              min={0}
              max={1}
              step={0.05}
              value={form.level_gap_fill_m}
              onChange={(event) =>
                updateForm({ ...form, level_gap_fill_m: Number(event.target.value) })
              }
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor="fp-venue_buffer_m" className="text-[13px] font-medium leading-[18px] text-foreground">
                {t("Venue buffer", "Venue バッファ")}
              </label>
              <span className="font-mono text-[11px] leading-[14px] tracking-[0.02em] text-muted-foreground">
                {form.venue_buffer_m.toFixed(1)} m
              </span>
            </div>
            <input
              id="fp-venue_buffer_m"
              type="range"
              className="h-4 w-full accent-foreground"
              min={0}
              max={10}
              step={0.5}
              value={form.venue_buffer_m}
              onChange={(event) =>
                updateForm({ ...form, venue_buffer_m: Number(event.target.value) })
              }
            />
          </div>
        </div>

        {/* Preview */}
        <div className="flex flex-col items-center rounded-lg border border-border bg-muted p-3">
          <span className="mb-2 text-xs font-medium text-muted-foreground">{t("Preview", "プレビュー")}</span>
          <svg
            width={SVG_SIZE}
            height={SVG_SIZE}
            viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
            className={`rounded bg-card ${loadingPreview ? "opacity-50" : ""}`}
          >
            {venuePath ? (
              <path
                d={venuePath}
                fill="hsl(var(--primary))"
                fillOpacity={0.1}
                stroke="hsl(var(--primary))"
                strokeWidth={1.5}
                strokeDasharray="6 3"
              />
            ) : null}
            {footprintPath ? (
              <path
                d={footprintPath}
                fill="hsl(var(--success))"
                fillOpacity={0.15}
                stroke="hsl(var(--success))"
                strokeWidth={2}
              />
            ) : null}
            {!footprintPath && !venuePath && !loadingPreview ? (
              <text
                x={SVG_SIZE / 2}
                y={SVG_SIZE / 2}
                textAnchor="middle"
                className="fill-muted-foreground text-xs"
              >
                {t("No unit geometry available", "ユニットジオメトリがありません")}
              </text>
            ) : null}
          </svg>
          <div className="mt-2 flex gap-4 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-sm border border-success bg-success/20" />
              {t("Footprint", "Footprint")}
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-sm border border-primary border-dashed bg-primary/10" />
              {t("Venue", "Venue")}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
