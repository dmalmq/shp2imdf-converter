import type { ProjectSummary } from "../api/client";

/** A shapefile project at Check with three errors; override what a test is about. */
export function projectSummary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: "s1",
    flow: "shapefiles",
    name: "東京駅",
    import_profile: "standard",
    stage: "check",
    updated_at: "2026-09-20T03:00:00Z",
    last_opened: "2026-09-20T03:00:00Z",
    blockers: 3,
    can_wait: 5,
    delivered_at: null,
    changed_since_delivery: false,
    expires_at: "2026-10-20T03:00:00Z",
    ...overrides
  };
}

/**
 * A zip reduced to what drop routing reads: a central directory naming
 * `entries`, and the end record pointing at it. The bytes before it stand in
 * for the file data.
 */
export function zipFile(name: string, entries: string[]): File {
  const encoder = new TextEncoder();
  const data = encoder.encode("PK\u0003\u0004 file data");
  const records = entries.map((entry) => {
    const bytes = encoder.encode(entry);
    const record = new Uint8Array(46 + bytes.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(28, bytes.length, true);
    record.set(bytes, 46);
    return record;
  });
  const directorySize = records.reduce((sum, record) => sum + record.length, 0);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, directorySize, true);
  view.setUint32(16, data.length, true);
  return new File([data, ...records, end], name);
}
