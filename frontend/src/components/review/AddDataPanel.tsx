import { useEffect, useMemo, useRef, useState } from "react";

import {
  commitSessionImport,
  discardStagedImport,
  fetchStagedFeatures,
  listImportBatches,
  restageSessionImport,
  stageSessionImport,
  undoImportBatch,
  type AppendBatchSummary,
  type AppendHostLevel,
  type AppendLevelDecision,
  type AppendLevelMatch,
  type AppendCandidateFeature,
  type AppendProfile,
  type AppendStageResponse
} from "../../api/client";
import { useApiErrorHandler } from "../../hooks/useApiErrorHandler";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { Button } from "../ui";
import { AppendSelectionPanel } from "./AppendSelectionPanel";
import {
  type SelectionState,
  emptySelection,
  isUnfiltered,
  selectionMatcher,
  summarise,
  toRequest
} from "./appendSelection";


type Props = {
  sessionId: string;
  /** Which reader the session itself was opened with, used as the default. */
  importProfile: "standard" | "imdf_shapefile";
  onClose: () => void;
  /** Called after a batch is added or undone, so the review screen reloads. */
  onChanged: () => void;
};

/** A level decision encoded for a <select>. */
const CREATE = "create";
const REJECT = "reject";

function bindValue(hostLevelId: string): string {
  return `bind:${hostLevelId}`;
}

export function decisionFromValue(candidateLevelId: string, value: string): AppendLevelDecision {
  if (value === CREATE) {
    return { candidate_level_id: candidateLevelId, action: "create" };
  }
  if (value === REJECT) {
    return { candidate_level_id: candidateLevelId, action: "reject" };
  }
  return {
    candidate_level_id: candidateLevelId,
    action: "bind",
    host_level_id: value.startsWith("bind:") ? value.slice("bind:".length) : value
  };
}

/** The value a level's dropdown starts on: its match, or nothing chosen yet. */
export function defaultDecisionValue(match: AppendLevelMatch): string {
  return match.host_level_id ? bindValue(match.host_level_id) : "";
}

export function hostLevelLabel(level: AppendHostLevel): string {
  return level.name || level.short_name || level.label || level.id;
}

export function candidateLevelLabel(match: AppendLevelMatch): string {
  return match.name || match.short_name || match.label || match.candidate_level_id;
}


export function AddDataPanel({ sessionId, importProfile, onClose, onChanged }: Props) {
  const { t } = useUiLanguage();
  const handleApiError = useApiErrorHandler();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [profile, setProfile] = useState<AppendProfile>(importProfile);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [preferFilenameFloor, setPreferFilenameFloor] = useState(false);
  const [staging, setStaging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [plan, setPlan] = useState<AppendStageResponse | null>(null);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [collisionPolicy, setCollisionPolicy] = useState<"remint" | "replace">("remint");
  const [applyAlignment, setApplyAlignment] = useState(true);
  const [expandLevels, setExpandLevels] = useState(true);
  const [codeColumn, setCodeColumn] = useState("");
  const [remapping, setRemapping] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<AppendCandidateFeature[]>([]);
  const [columnsByStem, setColumnsByStem] = useState<Record<string, string[]>>({});
  const [selection, setSelection] = useState<SelectionState>(emptySelection);
  const [batches, setBatches] = useState<AppendBatchSummary[]>([]);
  const [undoing, setUndoing] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setBatches(await listImportBatches(sessionId));
      } catch {
        // The batch list is a convenience; failing to read it must not block
        // the panel from being used to add data.
      }
    })();
  }, [sessionId]);

  const applyPlan = async (next: AppendStageResponse) => {
    setPlan(next);
    setSelection(emptySelection());
    try {
      const rows = await fetchStagedFeatures(sessionId, next.batch_id);
      setCandidates(rows.features);
      setColumnsByStem(rows.columns_by_stem);
    } catch {
      // Without the rows the whole batch simply comes in, which is the
      // behaviour from before selection existed.
      setCandidates([]);
      setColumnsByStem({});
    }
    setDecisions(
      Object.fromEntries(next.levels.map((match) => [match.candidate_level_id, defaultDecisionValue(match)]))
    );
    setCodeColumn(next.mappings?.unit.code_column ?? "");
    // Offered by default only when the gap really is a constant shift.
    setApplyAlignment(Boolean(next.alignment?.consistent));
  };

  const mappableColumns = useMemo(() => {
    const columns = new Set<string>();
    (plan?.files ?? []).forEach((file) => file.attribute_columns.forEach((column) => columns.add(column)));
    return [...columns].sort();
  }, [plan]);

  // With no candidate rows loaded the whole batch comes in, so only an
  // explicitly emptied selection blocks the commit.
  const nothingSelected = useMemo(
    () => candidates.length > 0 && summarise(candidates, selection).selected === 0,
    [candidates, selection]
  );

  /** How many of the *current selection* sit on each floor. */
  const selectedPerLevel = useMemo(() => {
    const matches = selectionMatcher(selection);
    const counts = new Map<string, number>();
    candidates.forEach((feature) => {
      if (feature.already_imported || !matches(feature)) {
        return;
      }
      const id = feature.level_id ?? "";
      counts.set(id, (counts.get(id) ?? 0) + 1);
    });
    return counts;
  }, [candidates, selection]);

  // Only the floors the selection actually touches. A batch spans every floor of
  // the station; a handful of picks touches one or two, and asking about the
  // rest — with their whole-batch counts — reads as though everything is coming
  // in. With no candidate rows loaded the whole batch comes in, so all of them
  // are in play.
  const activeLevels = useMemo(() => {
    if (!plan) {
      return [];
    }
    if (candidates.length === 0) {
      return plan.levels;
    }
    return plan.levels.filter((match) => (selectedPerLevel.get(match.candidate_level_id) ?? 0) > 0);
  }, [plan, candidates, selectedPerLevel]);

  const undecided = useMemo(
    () => activeLevels.filter((match) => !decisions[match.candidate_level_id]),
    [activeLevels, decisions]
  );

  const handleStage = async () => {
    if (selectedFiles.length === 0) {
      return;
    }
    setStaging(true);
    setProgress(0);
    setError(null);
    try {
      await applyPlan(
        await stageSessionImport(sessionId, selectedFiles, profile, setProgress, preferFilenameFloor)
      );
    } catch (caught) {
      setError(
        handleApiError(caught, t("Could not read those files.", "ファイルを読み取れませんでした。"), {
          title: t("Add data failed", "データの追加に失敗しました")
        })
      );
    } finally {
      setStaging(false);
    }
  };

  const handleRemap = async () => {
    if (!plan) {
      return;
    }
    setRemapping(true);
    setError(null);
    try {
      const mappings = plan.mappings ?? {
        unit: {
          code_column: null,
          name_column: null,
          alt_name_column: null,
          restriction_column: null,
          accessibility_column: null,
          available_categories: [],
          preview: []
        },
        opening: {
          category_column: null,
          accessibility_column: null,
          access_control_column: null,
          door_automatic_column: null,
          door_material_column: null,
          door_type_column: null,
          name_column: null
        },
        fixture: { name_column: null, alt_name_column: null, category_column: null },
        detail_confirmed: false
      };
      await applyPlan(
        await restageSessionImport(sessionId, plan.batch_id, {
          mappings: { ...mappings, unit: { ...mappings.unit, code_column: codeColumn || null } }
        })
      );
    } catch (caught) {
      setError(
        handleApiError(caught, t("Could not re-read the files.", "ファイルを再読み取りできませんでした。"), {
          title: t("Mapping failed", "マッピングに失敗しました")
        })
      );
    } finally {
      setRemapping(false);
    }
  };

  const handleCommit = async () => {
    if (!plan) {
      return;
    }
    setCommitting(true);
    setError(null);
    try {
      const result = await commitSessionImport(sessionId, {
        batch_id: plan.batch_id,
        level_decisions: activeLevels
          .map((match) => decisionFromValue(match.candidate_level_id, decisions[match.candidate_level_id] ?? ""))
          .filter((decision) => decision.action !== "bind" || Boolean(decision.host_level_id)),
        on_id_collision: collisionPolicy,
        selection: isUnfiltered(selection) ? null : toRequest(selection),
        apply_alignment: applyAlignment && Boolean(plan.alignment),
        expand_levels: expandLevels
      });
      onChanged();
      onClose();
      return result;
    } catch (caught) {
      setError(
        handleApiError(caught, t("Could not add that data.", "データを追加できませんでした。"), {
          title: t("Add data failed", "データの追加に失敗しました")
        })
      );
      return null;
    } finally {
      setCommitting(false);
    }
  };

  const handleCancel = async () => {
    if (plan) {
      try {
        await discardStagedImport(sessionId, plan.batch_id);
      } catch {
        // Nothing was committed, and the staged copy is cleaned up with the
        // session either way.
      }
    }
    onClose();
  };

  const handleUndo = async (batchId: string) => {
    setUndoing(batchId);
    setError(null);
    try {
      await undoImportBatch(sessionId, batchId);
      setBatches(await listImportBatches(sessionId));
      onChanged();
    } catch (caught) {
      setError(
        handleApiError(caught, t("Could not undo that.", "取り消せませんでした。"), {
          title: t("Undo failed", "取り消しに失敗しました")
        })
      );
    } finally {
      setUndoing(null);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/35 p-4">
      <div
        role="dialog"
        aria-label={t("Add data", "データを追加")}
        className="max-h-[92vh] w-full max-w-5xl overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-md)]"
      >
        <h3 className="text-lg font-semibold text-[var(--color-text)]">{t("Add data", "データを追加")}</h3>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          {t(
            "Add more layers to this dataset. Nothing changes until you confirm.",
            "このデータセットにレイヤーを追加します。確認するまで変更されません。"
          )}
        </p>

        {error ? (
          <p className="mt-3 rounded-[var(--radius-sm)] border border-[var(--color-error)]/20 bg-[var(--color-error-muted)] px-2 py-1 text-xs text-[var(--color-error)]">
            {error}
          </p>
        ) : null}

        {plan === null ? (
          <div className="mt-4 grid gap-3">
            <label className="block text-sm">
              <span className="mb-1 block text-[var(--color-text-secondary)]">{t("Source", "ソース")}</span>
              <select
                className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-2.5 py-1.5 text-sm"
                value={profile}
                onChange={(event) => setProfile(event.target.value as AppendProfile)}
              >
                <option value="imdf_shapefile">
                  {t("Shapefiles with IMDF fields", "IMDF 項目を持つシェープファイル")}
                </option>
                <option value="standard">{t("Shapefiles needing mapping", "マッピングが必要なシェープファイル")}</option>
                <option value="imdf">{t("IMDF archive (.zip)", "IMDF アーカイブ (.zip)")}</option>
              </select>
            </label>

            <label className="block text-sm">
              <span className="mb-1 block text-[var(--color-text-secondary)]">{t("Files", "ファイル")}</span>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                aria-label={t("Files", "ファイル")}
                className="w-full text-sm"
                onChange={(event) => setSelectedFiles([...(event.target.files ?? [])])}
              />
            </label>

            {profile === "imdf_shapefile" ? (
              <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
                <input
                  type="checkbox"
                  checked={preferFilenameFloor}
                  onChange={(event) => setPreferFilenameFloor(event.target.checked)}
                />
                {t("Trust the floor in the filename", "ファイル名の階を優先する")}
              </label>
            ) : null}

            {staging && progress > 0 ? (
              <p className="text-xs text-[var(--color-text-muted)]">{progress}%</p>
            ) : null}
          </div>
        ) : (
          <div className="mt-4 grid gap-4">
            <details open={plan.files.length <= 6}>
              <summary className="cursor-pointer text-sm font-semibold text-[var(--color-text)]">
                {t("Layers", "レイヤー")}{" "}
                <span className="font-normal text-xs text-[var(--color-text-muted)]">
                  ({plan.files.length},{" "}
                  {plan.files.reduce((total, file) => total + file.feature_count, 0)}{" "}
                  {t("features", "フィーチャ")})
                </span>
              </summary>
              {/* Capped: a station hands over forty-odd layers, and the list is
                  reference material, not something to scroll past every time. */}
              <ul className="mt-1 grid max-h-40 gap-1 overflow-y-auto text-sm text-[var(--color-text-secondary)]">
                {plan.files.map((file) => (
                  <li key={file.stem} className="flex items-baseline justify-between gap-2 pr-2">
                    <span className="font-mono text-xs">{file.stem}</span>
                    <span className="shrink-0 text-xs text-[var(--color-text-muted)]">
                      {file.crs_detected ? (
                        <span className="mr-2">{file.crs_detected}</span>
                      ) : (
                        <span className="mr-2 text-[var(--color-warning)]">
                          {t("no .prj", ".prj なし")}
                        </span>
                      )}
                      {file.feature_count} {file.detected_type ?? t("unknown", "不明")}
                    </span>
                  </li>
                ))}
              </ul>
            </details>

            <label className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-text-secondary)]">
              <input
                type="checkbox"
                aria-label={t("Expand floors to fit what is added", "追加分に合わせて階を拡張")}
                className="mt-0.5"
                checked={expandLevels}
                onChange={(event) => setExpandLevels(event.target.checked)}
              />
              <span>
                {t(
                  "Grow a floor when something added reaches past its edge. Apple rejects a room outside the floor it names, reported as an invalid level reference.",
                  "追加したものが階の範囲をはみ出す場合、階を拡張します。Apple は階の外にある部屋を無効なレベル参照として拒否します。"
                )}
              </span>
            </label>

            {plan.alignment ? (
              <section
                className={[
                  "rounded-[var(--radius-md)] border px-3 py-2 text-xs",
                  plan.alignment.consistent
                    ? "border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)]"
                    : "border-[var(--color-warning)]/20 bg-[var(--color-warning-muted)] text-[var(--color-warning)]"
                ].join(" ")}
              >
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    aria-label={t("Shift to match the existing data", "既存データに合わせて移動")}
                    className="mt-0.5"
                    checked={applyAlignment}
                    onChange={(event) => setApplyAlignment(event.target.checked)}
                  />
                  <span>
                    {plan.alignment.from_session
                      ? t(
                          `These layers sit ${plan.alignment.distance_metres.toFixed(2)} m from the data already here, measured on an earlier batch. Shift them to match.`,
                          `これらのレイヤーは既存データから ${plan.alignment.distance_metres.toFixed(2)} m ずれています（以前の取り込みで計測）。合わせて移動します。`
                        )
                      : t(
                          `These layers sit ${plan.alignment.distance_metres.toFixed(2)} m from the data already here, measured on ${plan.alignment.sample_count} features present in both. Shift them to match.`,
                          `これらのレイヤーは既存データから ${plan.alignment.distance_metres.toFixed(2)} m ずれています（両方に存在する ${plan.alignment.sample_count} 件で計測）。合わせて移動します。`
                        )}
                    <span className="ml-1 text-[var(--color-text-muted)]">
                      ({plan.alignment.east_metres >= 0 ? "E" : "W"}{" "}
                      {Math.abs(plan.alignment.east_metres).toFixed(2)} m,{" "}
                      {plan.alignment.north_metres >= 0 ? "N" : "S"}{" "}
                      {Math.abs(plan.alignment.north_metres).toFixed(2)} m
                      {plan.alignment.consistent
                        ? t(`, consistent to ${plan.alignment.spread_cm.toFixed(1)} cm`, `、誤差 ${plan.alignment.spread_cm.toFixed(1)} cm`)
                        : ""}
                      )
                    </span>
                    {!plan.alignment.consistent ? (
                      <span className="mt-1 block">
                        {t(
                          "The gap is not the same everywhere, so this is probably not a datum difference and a single shift will not fix it.",
                          "ずれが一定ではないため、測地系の違いではない可能性が高く、一律の移動では解決しません。"
                        )}
                      </span>
                    ) : null}
                  </span>
                </label>
              </section>
            ) : null}

            {candidates.length > 0 ? (
              <AppendSelectionPanel
                features={candidates}
                columnsByStem={columnsByStem}
                selection={selection}
                onChange={setSelection}
              />
            ) : null}

            {/* Only the standard profile maps attributes; the IMDF readers take
                their categories from the source fields and reject a re-stage. */}
            {plan.profile === "standard" ? (
              <section>
                <h4 className="text-sm font-semibold text-[var(--color-text)]">{t("Category column", "分類列")}</h4>
                {plan.needs_mapping ? (
                  <p className="mt-1 rounded-[var(--radius-sm)] border border-[var(--color-warning)]/20 bg-[var(--color-warning-muted)] px-2 py-1 text-xs text-[var(--color-warning)]">
                    {t(
                      "No category column is set, so every added room falls back to the default category.",
                      "分類列が設定されていないため、追加される部屋はすべて既定の分類になります。"
                    )}
                  </p>
                ) : null}
                <div className="mt-2 flex items-end gap-2">
                  <label className="block flex-1 text-sm">
                    <select
                      aria-label={t("Category column", "分類列")}
                      className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-2.5 py-1.5 text-sm"
                      value={codeColumn}
                      onChange={(event) => setCodeColumn(event.target.value)}
                    >
                      <option value="">{t("(none)", "(なし)")}</option>
                      {mappableColumns.map((column) => (
                        <option key={column} value={column}>
                          {column}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleRemap()}
                    disabled={remapping || codeColumn === (plan.mappings?.unit.code_column ?? "")}
                  >
                    {remapping ? t("Re-reading...", "再読み取り中...") : t("Apply", "適用")}
                  </Button>
                </div>
              </section>
            ) : null}

            <section>
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-[var(--color-text)]">
                  {t("Floors", "階")}
                  {activeLevels.length > 0 ? (
                    <span className="ml-1 font-normal text-xs text-[var(--color-text-muted)]">
                      {t(
                        `${activeLevels.length} of ${plan.levels.length} touched by this selection`,
                        `この選択が対象とするのは ${plan.levels.length} 階中 ${activeLevels.length} 階`
                      )}
                    </span>
                  ) : null}
                </h4>
                {undecided.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setDecisions((current) => {
                        const next = { ...current };
                        undecided.forEach((match) => {
                          next[match.candidate_level_id] = CREATE;
                        });
                        return next;
                      })
                    }
                  >
                    {t(
                      `Add all ${undecided.length} as new floors`,
                      `${undecided.length} 件すべてを新しい階として追加`
                    )}
                  </Button>
                ) : null}
              </div>
              <ul className="mt-1 grid max-h-72 gap-2 overflow-y-auto pr-1">
                {activeLevels.map((match) => {
                  const options =
                    match.host_level_options.length > 0 ? match.host_level_options : plan.host_levels;
                  return (
                    <li key={match.candidate_level_id} className="grid gap-1">
                      <span className="text-sm text-[var(--color-text)]">
                        {candidateLevelLabel(match)}{" "}
                        <span className="text-xs text-[var(--color-text-muted)]">
                          (
                          {candidates.length > 0
                            ? selectedPerLevel.get(match.candidate_level_id) ?? 0
                            : match.feature_count}{" "}
                          {t("features", "フィーチャ")})
                        </span>
                      </span>
                      <select
                        aria-label={t(
                          `Where to put ${candidateLevelLabel(match)}`,
                          `${candidateLevelLabel(match)} の配置先`
                        )}
                        className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-2.5 py-1.5 text-sm"
                        value={decisions[match.candidate_level_id] ?? ""}
                        onChange={(event) =>
                          setDecisions((current) => ({
                            ...current,
                            [match.candidate_level_id]: event.target.value
                          }))
                        }
                      >
                        <option value="">{t("Choose...", "選択...")}</option>
                        {options.map((level) => (
                          <option key={level.id} value={bindValue(level.id)}>
                            {t("Add to", "追加先")} {hostLevelLabel(level)}
                          </option>
                        ))}
                        <option value={CREATE}>{t("Add as a new floor", "新しい階として追加")}</option>
                        <option value={REJECT}>{t("Leave out", "含めない")}</option>
                      </select>
                      {match.match_basis === "ambiguous" ? (
                        <span className="text-xs text-[var(--color-warning)]">
                          {t(
                            "Several floors match this one, so pick the right one.",
                            "複数の階が一致するため、正しいものを選んでください。"
                          )}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>

            {plan.id_collisions > 0 ? (
              <section>
                <h4 className="text-sm font-semibold text-[var(--color-text)]">
                  {t("Repeated ids", "重複 ID")}
                </h4>
                <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                  {t(
                    `${plan.id_collisions} incoming feature(s) use an id this dataset already has.`,
                    `${plan.id_collisions} 件のフィーチャが、このデータセットに既にある ID を使用しています。`
                  )}
                </p>
                <select
                  aria-label={t("Repeated ids", "重複 ID")}
                  className="mt-2 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-2.5 py-1.5 text-sm"
                  value={collisionPolicy}
                  onChange={(event) => setCollisionPolicy(event.target.value as "remint" | "replace")}
                >
                  <option value="remint">{t("Keep both, give the new one a new id", "両方を残し、新しい方に新 ID を付与")}</option>
                  <option value="replace">{t("Replace the existing feature", "既存のフィーチャを置き換える")}</option>
                </select>
              </section>
            ) : null}

            {plan.warnings.length > 0 ? (
              <ul className="grid gap-1">
                {plan.warnings.map((warning) => (
                  <li
                    key={warning}
                    className="rounded-[var(--radius-sm)] border border-[var(--color-warning)]/20 bg-[var(--color-warning-muted)] px-2 py-1 text-xs text-[var(--color-warning)]"
                  >
                    {warning}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}

        {batches.length > 0 && plan === null ? (
          <section className="mt-4 border-t border-[var(--color-border)] pt-3">
            <h4 className="text-sm font-semibold text-[var(--color-text)]">{t("Already added", "追加済み")}</h4>
            <ul className="mt-1 grid gap-1">
              {batches.map((batch) => (
                <li key={batch.batch_id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-[var(--color-text-secondary)]">
                    <span className="font-mono text-xs">{batch.file_stems.join(", ") || batch.profile}</span>{" "}
                    <span className="text-xs text-[var(--color-text-muted)]">
                      ({batch.feature_count} {t("features", "フィーチャ")})
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleUndo(batch.batch_id)}
                    disabled={undoing === batch.batch_id}
                  >
                    {undoing === batch.batch_id ? t("Undoing...", "取り消し中...") : t("Undo", "取り消す")}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => void handleCancel()}>
            {t("Cancel", "キャンセル")}
          </Button>
          {plan === null ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleStage()}
              disabled={staging || selectedFiles.length === 0}
            >
              {staging ? t("Reading...", "読み取り中...") : t("Continue", "続行")}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleCommit()}
              disabled={committing || undecided.length > 0 || nothingSelected}
            >
              {committing ? t("Adding...", "追加中...") : t("Add to dataset", "データセットに追加")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
