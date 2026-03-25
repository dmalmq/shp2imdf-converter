import { useCallback, useEffect, useRef, useState } from "react";

import { fetchFootprintPreview, type FootprintPreview, type FootprintWizardState } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { useAppStore } from "../../store/useAppStore";


type Props = {
  footprint: FootprintWizardState;
  saving: boolean;
  onSave: (payload: FootprintWizardState) => void;
};

const SVG_SIZE = 320;
const SVG_PAD = 16;

function polygonsToSvgPaths(
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


export function FootprintStep({ footprint, saving, onSave }: Props) {
  const { t } = useUiLanguage();
  const sessionId = useAppStore((state) => state.sessionId);
  const [form, setForm] = useState<FootprintWizardState>(footprint);
  const [preview, setPreview] = useState<FootprintPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setForm(footprint);
  }, [footprint]);

  const fetchPreview = useCallback(
    (state: FootprintWizardState) => {
      if (!sessionId) return;
      setLoadingPreview(true);
      fetchFootprintPreview(sessionId, state.method, state.footprint_buffer_m, state.venue_buffer_m)
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
      setForm(next);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => fetchPreview(next), 300);
    },
    [fetchPreview]
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
    <section className="rounded border bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("Step 9: Footprint Options", "Step 9: Footprint 設定")}</h2>
        <button
          type="button"
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-60"
          disabled={saving}
          onClick={() => onSave(form)}
        >
          {saving ? t("Saving...", "保存中...") : t("Save Footprint Options", "Footprint 設定を保存")}
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        {/* Controls */}
        <div className="grid gap-4 self-start md:grid-cols-2 lg:grid-cols-1">
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">{t("Footprint Method", "Footprint 生成方法")}</span>
            <select
              className="w-full rounded border px-2 py-1.5"
              value={form.method}
              onChange={(event) =>
                updateForm({
                  ...form,
                  method: event.target.value as FootprintWizardState["method"]
                })
              }
            >
              <option value="union_buffer">{t("Union + buffer (default)", "Union + バッファ（標準）")}</option>
              <option value="convex_hull">{t("Convex hull", "凸包")}</option>
              <option value="concave_hull">{t("Concave hull", "凹包")}</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">
              {t("Footprint Buffer (m)", "Footprint バッファ (m)")}: {form.footprint_buffer_m.toFixed(1)}
            </span>
            <input
              type="range"
              className="w-full"
              min={0}
              max={3}
              step={0.1}
              value={form.footprint_buffer_m}
              onChange={(event) =>
                updateForm({ ...form, footprint_buffer_m: Number(event.target.value) })
              }
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">
              {t("Venue Buffer (m)", "Venue バッファ (m)")}: {form.venue_buffer_m.toFixed(1)}
            </span>
            <input
              type="range"
              className="w-full"
              min={0}
              max={10}
              step={0.5}
              value={form.venue_buffer_m}
              onChange={(event) =>
                updateForm({ ...form, venue_buffer_m: Number(event.target.value) })
              }
            />
          </label>
        </div>

        {/* Preview */}
        <div className="flex flex-col items-center rounded border bg-slate-50 p-3">
          <span className="mb-2 text-xs font-medium text-slate-500">{t("Preview", "プレビュー")}</span>
          <svg
            width={SVG_SIZE}
            height={SVG_SIZE}
            viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
            className={`rounded bg-white ${loadingPreview ? "opacity-50" : ""}`}
          >
            {venuePath ? (
              <path
                d={venuePath}
                fill="var(--color-primary, #2563eb)"
                fillOpacity={0.1}
                stroke="var(--color-primary, #2563eb)"
                strokeWidth={1.5}
                strokeDasharray="6 3"
              />
            ) : null}
            {footprintPath ? (
              <path
                d={footprintPath}
                fill="var(--color-success, #059669)"
                fillOpacity={0.15}
                stroke="var(--color-success, #059669)"
                strokeWidth={2}
              />
            ) : null}
            {!footprintPath && !venuePath && !loadingPreview ? (
              <text
                x={SVG_SIZE / 2}
                y={SVG_SIZE / 2}
                textAnchor="middle"
                className="fill-slate-400 text-xs"
              >
                {t("No unit geometry available", "ユニットジオメトリがありません")}
              </text>
            ) : null}
          </svg>
          <div className="mt-2 flex gap-4 text-[10px] text-slate-500">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-sm border border-emerald-600 bg-emerald-600/20" />
              {t("Footprint", "Footprint")}
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-sm border border-blue-600 border-dashed bg-blue-600/10" />
              {t("Venue", "Venue")}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
