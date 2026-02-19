import { useEffect, useState } from "react";

import type { FootprintWizardState } from "../../api/client";


type Props = {
  footprint: FootprintWizardState;
  saving: boolean;
  onSave: (payload: FootprintWizardState) => void;
};


export function FootprintStep({ footprint, saving, onSave }: Props) {
  const [form, setForm] = useState<FootprintWizardState>(footprint);

  useEffect(() => {
    setForm(footprint);
  }, [footprint]);

  return (
    <section className="rounded border bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Step 9: Footprint Options</h2>
        <button
          type="button"
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-60"
          disabled={saving}
          onClick={() => onSave(form)}
        >
          {saving ? "Saving..." : "Save Footprint Options"}
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="text-sm md:col-span-2">
          <span className="mb-1 block text-slate-600">Footprint Method</span>
          <select
            className="w-full rounded border px-2 py-1.5"
            value={form.method}
            onChange={(event) =>
              setForm((prev) => ({
                ...prev,
                method: event.target.value as FootprintWizardState["method"]
              }))
            }
          >
            <option value="union_buffer">Union + buffer (default)</option>
            <option value="convex_hull">Convex hull</option>
            <option value="concave_hull">Concave hull</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">
            Footprint Buffer (m): {form.footprint_buffer_m.toFixed(1)}
          </span>
          <input
            type="range"
            className="w-full"
            min={0}
            max={3}
            step={0.1}
            value={form.footprint_buffer_m}
            onChange={(event) =>
              setForm((prev) => ({
                ...prev,
                footprint_buffer_m: Number(event.target.value)
              }))
            }
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">Venue Buffer (m): {form.venue_buffer_m.toFixed(1)}</span>
          <input
            type="range"
            className="w-full"
            min={0}
            max={10}
            step={0.5}
            value={form.venue_buffer_m}
            onChange={(event) =>
              setForm((prev) => ({
                ...prev,
                venue_buffer_m: Number(event.target.value)
              }))
            }
          />
        </label>
      </div>

      <div className="mt-4 rounded border bg-slate-50 p-3 text-xs text-slate-600">
        Preview thumbnails and geometry preview are expanded in Phase 4 generator work.
      </div>
    </section>
  );
}
