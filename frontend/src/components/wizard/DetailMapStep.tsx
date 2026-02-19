import { useMemo } from "react";

import type { ImportedFile } from "../../api/client";


type Props = {
  files: ImportedFile[];
};


export function DetailMapStep({ files }: Props) {
  const detailFiles = useMemo(() => files.filter((item) => item.detected_type === "detail"), [files]);
  const detailFeatureCount = useMemo(
    () => detailFiles.reduce((sum, file) => sum + file.feature_count, 0),
    [detailFiles]
  );

  return (
    <section className="rounded border bg-white p-5">
      <h2 className="text-lg font-semibold">Step 8: Detail Mapping</h2>
      <p className="mt-2 text-sm text-slate-600">
        Detail features require no attribute mapping. They will export with geometry + level assignment from Step 3.
      </p>
      <div className="mt-3 rounded border bg-slate-50 p-3 text-sm">
        <p>
          Detail files detected: <span className="font-semibold">{detailFiles.length}</span>
        </p>
        <p>
          Detail features total: <span className="font-semibold">{detailFeatureCount}</span>
        </p>
      </div>
      {detailFiles.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-slate-600">
          {detailFiles.map((file) => (
            <li key={file.stem} className="font-mono">
              {file.stem}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
