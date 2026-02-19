export type CleanupSummary = {
  multipolygons_exploded: number;
  rings_closed: number;
  features_reoriented: number;
  empty_features_dropped: number;
  coordinates_rounded: number;
};

export type ImportedFile = {
  stem: string;
  geometry_type: string;
  feature_count: number;
  attribute_columns: string[];
  detected_type: string | null;
  detected_level: number | null;
  confidence: string;
  crs_detected: string | null;
  warnings: string[];
};

export type ImportResponse = {
  session_id: string;
  files: ImportedFile[];
  cleanup_summary: CleanupSummary;
  warnings: string[];
};

export async function importShapefiles(
  files: File[],
  onProgress?: (percent: number) => void
): Promise<ImportResponse> {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/import");

    request.upload.onprogress = (event) => {
      if (!event.lengthComputable || !onProgress) {
        return;
      }
      const percent = Math.round((event.loaded / event.total) * 100);
      onProgress(percent);
    };

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve(JSON.parse(request.responseText) as ImportResponse);
        return;
      }
      reject(new Error(request.responseText || "Import failed"));
    };

    request.onerror = () => reject(new Error("Network error during upload"));
    request.send(formData);
  });
}

