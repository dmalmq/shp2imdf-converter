import { LOCATED_FEATURE_TYPES } from "./types";


type Props = {
  layerVisibility: Record<string, boolean>;
  levelFilter: string;
  levelOptions: Array<{ id: string; label: string }>;
  onLayerVisibilityChange: (next: Record<string, boolean>) => void;
  onLevelFilterChange: (next: string) => void;
};


export function LayerTree({
  layerVisibility,
  levelFilter,
  levelOptions,
  onLayerVisibilityChange,
  onLevelFilterChange
}: Props) {
  return (
    <div className="rounded border bg-white p-3">
      <h3 className="mb-2 text-sm font-semibold text-slate-700">Layers</h3>
      <div className="grid gap-1">
        {LOCATED_FEATURE_TYPES.map((featureType) => {
          const checked = layerVisibility[featureType] ?? true;
          return (
            <label key={featureType} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) =>
                  onLayerVisibilityChange({
                    ...layerVisibility,
                    [featureType]: event.target.checked
                  })
                }
              />
              <span className="capitalize">{featureType}</span>
            </label>
          );
        })}
      </div>

      <label className="mt-3 block text-sm">
        <span className="mb-1 block text-slate-600">Level Filter</span>
        <select
          className="w-full rounded border px-2 py-1.5"
          value={levelFilter}
          onChange={(event) => onLevelFilterChange(event.target.value)}
        >
          <option value="">All Levels</option>
          {levelOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

