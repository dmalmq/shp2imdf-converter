import { AlertTriangle, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { fetchTileJobFile, fetchTileJobIndex } from "../api/client";
import { ApiClientError, toErrorMessage } from "../api/errors";
import { usePageShell } from "../components/shell/ShellContext";
import { COLOR_THEME_PATH } from "../components/shell/stages";
import { TileMap, type PickedFeature } from "../components/tileViewer/TileMap";
import { Button, Checkbox, SectionHeader } from "../components/ui";
import { useUiLanguage } from "../hooks/useUiLanguage";
import {
  STYLE_PATH,
  approximateScale,
  drawnFrom,
  emptyTileStats,
  folderFiles,
  noTilesFound,
  prepareStyle,
  soloVisibility,
  stepFloor,
  tileLevels,
  type Fatal,
  type Prepared,
  type Problem,
  type SourceInfo,
  type TileIndex,
  type TileStats,
  type VtilesSource
} from "../lib/vtiles";
import { cn } from "@/lib/utils";

type T = (english: string, japanese: string) => string;
type Ready = Extract<Prepared, { ok: true }>;

/** Where the tiles come from, for the panel's heading. */
type Origin = { kind: "build"; jobId: string } | { kind: "folder" };

type Load =
  | { state: "choose" }
  | { state: "loading" }
  /** The build is not on the server: restarted, or expired. */
  | { state: "gone" }
  | { state: "failed"; message: string }
  | { state: "fatal"; fatal: Fatal }
  /** `opened` counts every source opened, so a second folder of the same name starts a fresh viewer. */
  | { state: "ready"; origin: Origin; source: VtilesSource; prepared: Ready; opened: number };

const formatCount = (value: number) => value.toLocaleString("en-US");

async function open(source: VtilesSource, signal: AbortSignal): Promise<Prepared> {
  const readJson = async (path: string) => {
    const data = await source.read(path, signal);
    if (data === null) return null;
    try {
      return JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  return prepareStyle(await source.read(STYLE_PATH, signal), readJson, source.index);
}

function buildSource(jobId: string, index: TileIndex): VtilesSource {
  return { index, read: (path, signal) => fetchTileJobFile(jobId, path, signal) };
}

function folderSource(name: string, files: Map<string, File>): VtilesSource {
  return {
    index: { name, levels: tileLevels(files.keys()) },
    read: async (path) => (await files.get(path)?.arrayBuffer()) ?? null
  };
}

/** /color-theme/tiles[/:jobId]: a vector tile build's tiles on a map, or a `.vtiles` folder picked from disk. */
export function TileViewerPage() {
  const { jobId } = useParams<{ jobId?: string }>();
  const { t } = useUiLanguage();
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>(jobId ? { state: "loading" } : { state: "choose" });
  const folderInput = useRef<HTMLInputElement>(null);
  const inflight = useRef<AbortController | null>(null);
  const opened = useRef(0);

  const start = useCallback(async (origin: Origin, source: Promise<VtilesSource>) => {
    inflight.current?.abort();
    const request = new AbortController();
    inflight.current = request;
    setLoad({ state: "loading" });
    try {
      const ready = await source;
      const prepared = await open(ready, request.signal);
      if (request.signal.aborted) return;
      opened.current += 1;
      setLoad(
        prepared.ok
          ? { state: "ready", origin, source: ready, prepared, opened: opened.current }
          : { state: "fatal", fatal: prepared.fatal }
      );
    } catch (caught) {
      if (request.signal.aborted) return;
      setLoad(
        caught instanceof ApiClientError && caught.status === 404
          ? { state: "gone" }
          : { state: "failed", message: toErrorMessage(caught, "") }
      );
    }
  }, []);

  // Leaving a build's URL for a picked folder must not undo the folder.
  useEffect(() => {
    if (!jobId) return;
    void start({ kind: "build", jobId }, fetchTileJobIndex(jobId).then((index) => buildSource(jobId, index)));
  }, [jobId, start]);

  useEffect(() => () => inflight.current?.abort(), []);

  // React has no prop for it; the folder picker is what keeps the folder layout.
  useEffect(() => {
    if (folderInput.current) folderInput.current.webkitdirectory = true;
  }, []);

  const picked = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])].map((file) => ({ path: file.webkitRelativePath || file.name, file }));
    event.target.value = "";
    const found = folderFiles(files);
    if (!found) {
      setLoad({ state: "fatal", fatal: { kind: "no-style" } });
      return;
    }
    if (jobId) navigate(`${COLOR_THEME_PATH}/tiles`);
    void start({ kind: "folder" }, Promise.resolve(folderSource(found.name, found.files)));
  };

  usePageShell({
    current: "deliver",
    station: load.state === "ready" ? load.source.index.name : null,
    targets: ["bring-in"],
    go: { "bring-in": () => navigate(COLOR_THEME_PATH) }
  });

  const chooseFolder = (
    <Button variant="outline" size="sm" onClick={() => folderInput.current?.click()}>
      <FolderOpen aria-hidden="true" />
      {t("Open a .vtiles folder", ".vtiles フォルダを開く")}
    </Button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <input ref={folderInput} type="file" multiple className="hidden" data-testid="tile-viewer-folder-input" onChange={picked} />
      {load.state === "ready" ? (
        <Viewer key={load.opened} load={load} chooseFolder={chooseFolder} />
      ) : (
        <Notice load={load} chooseFolder={chooseFolder} t={t} />
      )}
    </div>
  );
}

function Notice({ load, chooseFolder, t }: { load: Exclude<Load, { state: "ready" }>; chooseFolder: ReactNode; t: T }) {
  let title: string;
  let body: ReactNode;
  switch (load.state) {
    case "loading":
      return (
        <div role="status" className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("Reading the tiles…", "タイルを読み込み中…")}
        </div>
      );
    case "choose":
      title = t("View vector tiles", "ベクタータイルを表示");
      body = t(
        "Open the .vtiles folder that ArcGIS Pro’s Extract Package made, or the folder it is in. Nothing is uploaded: the tiles are read from this computer.",
        "ArcGIS Pro の「パッケージの抽出」で作成した .vtiles フォルダ、またはそれを含むフォルダを開いてください。アップロードはされず、タイルはこのコンピューターから読み込みます。"
      );
      break;
    case "gone":
      title = t("This build is no longer on the server", "この作成結果はサーバーにありません");
      body = t(
        "The server was restarted or the build expired. Unzip the download and open its vector_tiles/<name>.vtiles folder instead.",
        "サーバーが再起動したか、期限が切れました。ダウンロードした zip を展開し、vector_tiles/<名前>.vtiles フォルダを開いてください。"
      );
      break;
    case "failed":
      title = t("The tiles could not be read", "タイルを読み込めませんでした");
      body = load.message;
      break;
    case "fatal":
      title = t("These tiles cannot be drawn", "このタイルは描画できません");
      body = fatalText(load.fatal, t);
      break;
  }
  return (
    <div className="flex flex-1 items-start justify-center px-14 pt-16">
      <div className="flex max-w-[36rem] flex-col gap-3 rounded-xl border border-border bg-card px-6 py-5">
        <h1 className="font-display text-[22px] font-semibold leading-tight text-foreground">{title}</h1>
        <p className={cn("text-[14px] leading-[1.55]", load.state === "choose" ? "text-muted-foreground" : "text-foreground")}>{body}</p>
        <div>{chooseFolder}</div>
      </div>
    </div>
  );
}

function fatalText(fatal: Fatal, t: T): string {
  switch (fatal.kind) {
    case "no-style":
      return t(
        `No ${STYLE_PATH} was found. Open the .vtiles folder itself, the one that holds the resources and tile folders.`,
        `${STYLE_PATH} が見つかりません。resources フォルダと tile フォルダを含む .vtiles フォルダを開いてください。`
      );
    case "style-not-json":
      return t(
        `${STYLE_PATH} is not valid JSON (${fatal.message}). Check that an edit did not remove a comma, quote or bracket.`,
        `${STYLE_PATH} が正しい JSON ではありません（${fatal.message}）。編集でカンマ、引用符、括弧が消えていないか確認してください。`
      );
    case "no-vector-source":
      return t("The style has no vector source, so there are no tiles to show.", "スタイルにベクターソースがないため、表示するタイルがありません。");
  }
}

function problemText(problem: Problem, t: T): string {
  switch (problem.kind) {
    case "style-bom":
      return t(
        "root.json starts with a byte-order mark. Some apps refuse it: save it as UTF-8, not UTF-8 with BOM.",
        "root.json の先頭に BOM があります。受け付けないアプリがあるため、「UTF-8（BOM なし）」で保存してください。"
      );
    case "zoom-not-number":
      return t(
        `The style’s ${problem.key} is ${problem.value}. It must be a plain number, without quotes.`,
        `スタイルの ${problem.key} が ${problem.value} です。引用符のない数値にしてください。`
      );
    case "service-unreadable":
      return t(
        `The tile service description ${problem.path} could not be read, so Esri’s tile/{z}/{y}/{x}.pbf is assumed.`,
        `タイルサービスの説明 ${problem.path} を読めないため、Esri 標準の tile/{z}/{y}/{x}.pbf とみなします。`
      );
    case "no-tiles-or-url":
      return t(`Source ${problem.source} has neither tiles nor url, so nothing is loaded from it.`, `ソース ${problem.source} に tiles も url もないため、何も読み込みません。`);
    case "beyond-disk":
      return t(
        `The style allows tiles up to level ${problem.maxzoom}, but the deepest level stored is ${problem.deepest}. Closer in, the map asks for tiles that do not exist.`,
        `スタイルはレベル ${problem.maxzoom} までのタイルを使いますが、保存されている最も深いレベルは ${problem.deepest} です。拡大すると存在しないタイルを要求します。`
      );
    case "tiles-missing":
      return t(
        `Every tile asked for so far is missing (the first: ${problem.first}). The folder layout may not match the tile template.`,
        `これまでに要求したタイルがすべて見つかりません（最初: ${problem.first}）。フォルダ構成がタイルのテンプレートと合っていない可能性があります。`
      );
    case "glyphs-missing":
      return t(
        `Label fonts are missing (e.g. ${problem.path}). Latin label text may not show; Japanese is drawn with a system font.`,
        `ラベル用フォントがありません（例: ${problem.path}）。英字のラベルが表示されない場合があります。日本語はシステムフォントで描画します。`
      );
    case "map-error":
      return problem.message;
  }
}

function zoomOrigin(source: SourceInfo, t: T): string {
  switch (source.maxFrom) {
    case "style":
      return t("maximum from the style", "最大値はスタイルから");
    case "service":
      return t("maximum from the tile service", "最大値はタイルサービスから");
    case "disk":
      return t("maximum from the levels stored", "最大値は保存レベルから");
    case "default":
      return t("maximum by default", "最大値は既定値");
  }
}

function Viewer({ load, chooseFolder }: { load: Extract<Load, { state: "ready" }>; chooseFolder: ReactNode }) {
  const { t } = useUiLanguage();
  const { source, prepared, origin } = load;
  const groups = prepared.groups;
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(groups.map((group) => [group.name, true])));
  const [solo, setSolo] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [stats, setStats] = useState<TileStats>(emptyTileStats);
  const [runtime, setRuntime] = useState<Problem[]>([]);
  const [features, setFeatures] = useState<PickedFeature[] | null>(null);
  const [boundaries, setBoundaries] = useState(false);

  const showOnly = useCallback(
    (name: string) => {
      setSolo(name);
      setOn(soloVisibility(groups, name));
    },
    [groups]
  );
  const onProblem = useCallback(
    (problem: Problem) =>
      setRuntime((known) => (known.some((other) => JSON.stringify(other) === JSON.stringify(problem)) ? known : [...known, problem])),
    []
  );

  // Capture phase, so up and down change floors instead of panning the map.
  useEffect(() => {
    const step = (event: KeyboardEvent) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
      const next = stepFloor(groups, solo, event.key === "ArrowUp" ? -1 : 1);
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      showOnly(next);
    };
    document.addEventListener("keydown", step, true);
    return () => document.removeEventListener("keydown", step, true);
  }, [groups, solo, showOnly]);

  const problems = useMemo(() => {
    const all = [...prepared.problems, ...runtime];
    if (noTilesFound(stats) && stats.firstMissing) all.push({ kind: "tiles-missing", first: stats.firstMissing });
    return all;
  }, [prepared.problems, runtime, stats]);

  const levels = source.index.levels;
  const primary = prepared.primary;

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-[340px] shrink-0 flex-col overflow-y-auto border-r border-border bg-card" aria-label={t("Tile viewer", "タイルビューア")}>
        <header className="flex flex-col gap-1.5 border-b border-border px-4 pb-3 pt-4">
          <h1 className="text-[15px] font-semibold text-foreground">{source.index.name || t("Vector tiles", "ベクタータイル")}</h1>
          <p className="text-[12.5px] text-muted-foreground">
            {origin.kind === "build"
              ? t(`Build ${origin.jobId}, read from its download on the server`, `作成 ${origin.jobId}（サーバー上のダウンロードから読み込み）`)
              : t("A .vtiles folder on this computer", "このコンピューター上の .vtiles フォルダ")}
          </p>
          <div className="pt-1">{chooseFolder}</div>
        </header>

        <Section title={t("Zoom", "ズーム")}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
            <Row label={t("Map zoom", "地図のズーム")}>{zoom === null ? "–" : zoom.toFixed(2)}</Row>
            <Row label={t("Scale (approx.)", "縮尺（概算）")}>{zoom === null ? "–" : `1:${formatCount(approximateScale(zoom))}`}</Row>
            <Row label={t("Tiles drawn from", "描画元のタイル")}>
              {zoom === null ? "–" : <DrawnFrom zoom={zoom} source={primary} t={t} />}
            </Row>
            <Row label={t("Source zoom range", "ソースのズーム範囲")}>
              {`z${primary.minzoom}–z${primary.maxzoom}`}
              <span className="block font-sans text-muted-foreground">{zoomOrigin(primary, t)}</span>
            </Row>
            <Row label={t("Levels stored", "保存されたレベル")}>
              {levels.length ? `z${levels[0].z}–z${levels[levels.length - 1].z}` : t("none", "なし")}
            </Row>
            <Row label={t("Tile requests", "タイル要求")}>
              {t(`${formatCount(stats.loaded)} loaded`, `${formatCount(stats.loaded)} 件読み込み`)}
              {stats.missing ? (
                <span className="block text-muted-foreground">
                  {t(`${formatCount(stats.missing)} not stored`, `${formatCount(stats.missing)} 件は保存なし`)}
                  {` (z${Object.keys(stats.missingByLevel).join(", z")})`}
                </span>
              ) : null}
              {stats.failed ? <span className="block text-destructive">{t(`${formatCount(stats.failed)} failed`, `${formatCount(stats.failed)} 件失敗`)}</span> : null}
              {stats.loaded ? (
                <span className="block font-sans text-muted-foreground">
                  {stats.gzip === stats.loaded
                    ? t("gzip-compressed", "gzip 圧縮")
                    : stats.gzip
                      ? t("some gzip-compressed", "一部 gzip 圧縮")
                      : t("not compressed", "非圧縮")}
                </span>
              ) : null}
            </Row>
          </dl>
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-[12.5px] text-muted-foreground">
            <Checkbox checked={boundaries} onCheckedChange={(next) => setBoundaries(next === true)} />
            {t("Show tile boundaries", "タイル境界を表示")}
          </label>
        </Section>

        <Section
          title={t("Floors and groups", "フロアとグループ")}
          action={{
            label: t("All on", "すべて表示"),
            onClick: () => {
              setSolo(null);
              setOn(Object.fromEntries(groups.map((group) => [group.name, true])));
            }
          }}
        >
          <p className="mb-2 text-[12px] leading-[1.45] text-muted-foreground">
            {t(
              "Click a name to show only that floor and the background. ↑ and ↓ step through the floors.",
              "名前をクリックすると、そのフロアと背景だけを表示します。↑ と ↓ でフロアを切り替えます。"
            )}
          </p>
          <ul className="flex flex-col">
            {groups.map((group) => (
              <li
                key={group.name}
                className={cn("flex items-center gap-2 rounded-md px-1.5", solo === group.name ? "bg-accent" : "hover:bg-muted")}
              >
                <Checkbox
                  aria-label={t(`Show ${group.name || "ungrouped layers"}`, `${group.name || "グループなし"} を表示`)}
                  checked={Boolean(on[group.name])}
                  onCheckedChange={(next) => {
                    setSolo(null);
                    setOn((current) => ({ ...current, [group.name]: next === true }));
                  }}
                />
                <button
                  type="button"
                  className={cn(
                    "min-w-0 flex-1 py-1 text-left text-[13px] font-medium [overflow-wrap:anywhere]",
                    solo === group.name ? "text-accent-foreground" : "text-foreground"
                  )}
                  onClick={() => showOnly(group.name)}
                >
                  {group.name || t("(no group)", "（グループなし）")}
                </button>
                {group.background ? (
                  <span className="rounded border border-border px-1 text-[10px] text-muted-foreground">{t("background", "背景")}</span>
                ) : null}
                <span className="font-mono text-[11px] text-muted-foreground" title={t(`${group.layers.length} style layers`, `スタイルレイヤー ${group.layers.length} 件`)}>
                  {group.layers.length}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title={t("Inspect", "属性")}>
          <Inspect features={features} t={t} />
        </Section>

        {problems.length > 0 ? (
          <Section title={t("Problems", "問題")}>
            <ul className="flex flex-col gap-1.5" data-testid="tile-viewer-problems">
              {problems.map((problem, index) => (
                <li key={index} className="flex gap-2 text-[12.5px] leading-[1.45] text-warning-foreground [overflow-wrap:anywhere]">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {problemText(problem, t)}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
      </aside>

      <div className="relative min-w-0 flex-1">
        <TileMap
          source={source}
          prepared={prepared}
          on={on}
          showTileBoundaries={boundaries}
          onStats={setStats}
          onZoom={setZoom}
          onPick={setFeatures}
          onProblem={onProblem}
        />
      </div>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: { label: string; onClick: () => void }; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b border-border px-4 py-3.5">
      <SectionHeader title={title} action={action} />
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 text-right font-mono text-[12px] text-foreground">{children}</dd>
    </>
  );
}

function DrawnFrom({ zoom, source, t }: { zoom: number; source: SourceInfo; t: T }) {
  const drawn = drawnFrom(zoom, source);
  switch (drawn.kind) {
    case "below":
      return <span className="text-destructive">{t(`nothing, below z${drawn.minzoom}`, `なし（z${drawn.minzoom} 未満）`)}</span>;
    case "enlarged":
      return <span className="text-warning-foreground">{t(`z${drawn.z}, enlarged ×${drawn.factor}`, `z${drawn.z} を ×${drawn.factor} 拡大`)}</span>;
    case "level":
      return <>z{drawn.z}</>;
  }
}

function Inspect({ features, t }: { features: PickedFeature[] | null; t: T }) {
  if (features === null) {
    return <p className="text-[12px] text-muted-foreground">{t("Click the map to list the features under the cursor.", "地図をクリックすると、その位置の地物を一覧します。")}</p>;
  }
  if (features.length === 0) {
    return <p className="text-[12px] text-muted-foreground">{t("Nothing is drawn here.", "ここには何も描画されていません。")}</p>;
  }
  return (
    <div className="flex flex-col gap-2" data-testid="tile-viewer-inspect">
      {features.map((feature) => (
        <div key={`${feature.layer}|${JSON.stringify(feature.properties)}`} className="overflow-hidden rounded-lg border border-border">
          <div className="flex flex-wrap items-baseline gap-1.5 bg-muted px-2.5 py-1.5">
            {feature.group ? (
              <span className="rounded bg-foreground px-1.5 text-[10.5px] font-semibold text-background">{feature.group}</span>
            ) : null}
            <code className="font-mono text-[11.5px] text-foreground [overflow-wrap:anywhere]">{feature.layer}</code>
          </div>
          <p className="px-2.5 py-1 text-[11.5px] text-muted-foreground">
            {t("source layer", "ソースレイヤー")}: {feature.sourceLayer ?? "–"} · {feature.geometry}
          </p>
          {Object.keys(feature.properties).length > 0 ? (
            <table className="w-full text-[12px]">
              <tbody>
                {Object.entries(feature.properties).map(([key, value]) => (
                  <tr key={key} className="border-t border-border">
                    <td className="w-[42%] px-2.5 py-0.5 align-top text-muted-foreground [overflow-wrap:anywhere]">{key}</td>
                    <td className="px-2.5 py-0.5 align-top text-foreground [overflow-wrap:anywhere]">
                      {typeof value === "object" ? JSON.stringify(value) : String(value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ))}
    </div>
  );
}
