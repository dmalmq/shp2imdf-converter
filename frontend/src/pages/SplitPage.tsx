import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Layer, type MapLayerMouseEvent, type MapRef, Source } from "react-map-gl/maplibre";
import { Link } from "react-router-dom";
import { Layers, Pencil, Trash2 } from "lucide-react";

import {
  fetchSplitFeatures,
  fetchSplitGroups,
  previewSplit,
  splitSession,
  type ImportedFile,
  type LayerGroup,
  type SplitPreviewResponse,
  type SplitResponse
} from "../api/client";
import { toErrorMessage } from "../api/errors";
import { NextBar } from "../components/bringIn/NextBar";
import type { BasicFeature } from "../components/shared/PreviewMap";
import { MapView } from "../components/shared/MapView";
import { STREET_MAP_STYLE } from "../components/shared/streetMapStyle";
import { projectPath } from "../components/shell/stages";
import { Button, Input } from "../components/ui";
import { useApiErrorHandler } from "../hooks/useApiErrorHandler";
import { useUiLanguage } from "../hooks/useUiLanguage";
import { TYPE_LABELS } from "../lib/bringIn";
import {
  buildingColour,
  countsByFloor,
  filterFiles,
  filterGroups,
  floorOfStem,
  onFloor,
  pickedStems,
  pickOwners,
  previewBlocked,
  previewShapes,
  splitBlocked,
  splitFloors,
  splitShapes,
  type Building,
  type LngLat
} from "../lib/split";
import { useAppStore } from "../store/useAppStore";
import { cn } from "@/lib/utils";

/** Pixels from the first corner within which a click closes the outline. */
const CLOSE_PIXELS = 12;

function tokenColour(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parts = value.split(/\s+/);
  return parts.length === 3 ? `hsl(${parts.join(", ")})` : fallback;
}

function boundsOf(features: BasicFeature[]): [[number, number], [number, number]] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (value: unknown) => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      minX = Math.min(minX, value[0]);
      maxX = Math.max(maxX, value[0]);
      minY = Math.min(minY, value[1]);
      maxY = Math.max(maxY, value[1]);
      return;
    }
    value.forEach(visit);
  };
  features.forEach((feature) => visit(feature.geometry?.coordinates));
  return Number.isFinite(minX) ? [[minX, minY], [maxX, maxY]] : null;
}

/** Bring in → split: draw a shape over each building or pick its layers, and make a project of each. */
export function SplitPage() {
  const sessionId = useAppStore((state) => state.sessionId) ?? "";
  const files = useAppStore((state) => state.files);
  const handleApiError = useApiErrorHandler();
  const { t } = useUiLanguage();
  const mapRef = useRef<MapRef | null>(null);

  const [features, setFeatures] = useState<BasicFeature[] | null>(null);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [groups, setGroups] = useState<LayerGroup[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<LngLat[] | null>(null);
  const [floor, setFloor] = useState<number | null>(null);
  const [preview, setPreview] = useState<SplitPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SplitResponse | null>(null);
  const nextKey = useRef(1);

  useEffect(() => {
    let live = true;
    fetchSplitFeatures(sessionId).then(
      (response) => live && setFeatures(response.features as BasicFeature[]),
      (error: unknown) => {
        if (!live) return;
        setFeatures([]);
        handleApiError(error, t("Could not load the shapes", "図形を読み込めませんでした"));
      }
    );
    return () => {
      live = false;
    };
  }, [sessionId]);

  useEffect(() => {
    let live = true;
    fetchSplitGroups(sessionId).then(
      (response) => live && setGroups(response),
      () => live && setGroups([])
    );
    return () => {
      live = false;
    };
  }, [sessionId]);

  const floors = useMemo(() => splitFloors(files), [files]);
  const floorOf = useMemo(() => floorOfStem(files), [files]);

  const notYet = previewBlocked(buildings, groups);
  useEffect(() => {
    if (notYet) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      previewSplit(sessionId, previewShapes(buildings, groups)).then(
        (response) => {
          if (!live) return;
          setPreview(response);
          setPreviewError(null);
        },
        (error: unknown) => {
          if (!live) return;
          setPreview(null);
          setPreviewError(toErrorMessage(error, "Could not count the features"));
        }
      );
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // Names are placeholders in the preview, so renaming must not recount.
  }, [
    sessionId,
    notYet?.en,
    buildings.map((building) => JSON.stringify([building.corners, pickedStems(building, groups)])).join("|")
  ]);

  const fitted = useRef(false);
  const fitAll = useCallback(() => {
    if (fitted.current || !features?.length || !mapRef.current) return;
    const bounds = boundsOf(features);
    if (!bounds) return;
    mapRef.current.fitBounds(bounds, { padding: 40, duration: 0 });
    fitted.current = true;
  }, [features]);
  useEffect(fitAll, [fitAll]);

  const activeIndex = buildings.findIndex((building) => building.key === active);
  const colours = {
    outside: tokenColour("--destructive", "#b14a2d"),
    unknown: tokenColour("--muted-foreground", "#68645b")
  };
  const featureColour = ["get", "split_colour"] as unknown as string;
  const draftColour = buildingColour(`b${nextKey.current}`);
  const shownFeatures = useMemo(() => {
    if (!features) return { type: "FeatureCollection", features: [] };
    const owners = preview?.owners ?? {};
    return {
      type: "FeatureCollection",
      features: features
        .filter((feature) => onFloor(feature.properties?.source_file, floor, floorOf))
        .map((feature) => {
          const ref = feature.properties?.source_feature_ref;
          const owner = typeof ref === "string" ? owners[ref] : undefined;
          const role = owner === undefined ? (preview ? "outside" : "unknown") : owner === activeIndex ? "active" : "other";
          const colour =
            owner === undefined ? (preview ? colours.outside : colours.unknown) : buildingColour(buildings[owner]?.key ?? "");
          return { ...feature, properties: { ...feature.properties, split_role: role, split_colour: colour } };
        })
    };
  }, [features, floor, floorOf, preview, activeIndex, buildings, colours.outside, colours.unknown]);

  const outlines = useMemo(
    () => ({
      type: "FeatureCollection",
      features: buildings.flatMap((building, index) =>
        building.corners
          ? [
              {
                type: "Feature",
                properties: { active: index === activeIndex, colour: buildingColour(building.key) },
                geometry: { type: "Polygon", coordinates: [[...building.corners, building.corners[0]]] }
              }
            ]
          : []
      )
    }),
    [buildings, activeIndex]
  );

  const draftData = useMemo(
    () => ({
      type: "FeatureCollection",
      features: draft
        ? [
            { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: draft } },
            ...draft.map((corner) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: corner } }))
          ]
        : []
    }),
    [draft]
  );

  const finishDraft = useCallback(() => {
    if (!draft || draft.length < 3) return;
    const key = `b${nextKey.current++}`;
    setBuildings((previous) => [...previous, { key, name: "", corners: draft, files: [], groups: [] }]);
    setActive(key);
    setPicking(false);
    setDraft(null);
  }, [draft]);

  const addPickedBuilding = () => {
    const key = `b${nextKey.current++}`;
    setBuildings((previous) => [...previous, { key, name: "", corners: null, files: [], groups: [] }]);
    setActive(key);
    setPicking(true);
  };
  const updateBuilding = (key: string, change: (building: Building) => Building) =>
    setBuildings((previous) => previous.map((item) => (item.key === key ? change(item) : item)));

  useEffect(() => {
    if (!draft) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDraft(null);
      if (event.key === "Enter") finishDraft();
      if (event.key === "Backspace" && !(event.target instanceof HTMLInputElement)) {
        setDraft((corners) => (corners ? corners.slice(0, -1) : corners));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, finishDraft]);

  const onMapClick = (event: MapLayerMouseEvent) => {
    if (!draft) return;
    const corner: LngLat = [event.lngLat.lng, event.lngLat.lat];
    const map = mapRef.current;
    if (draft.length >= 3 && map) {
      const first = map.project(draft[0]);
      if (Math.hypot(first.x - event.point.x, first.y - event.point.y) <= CLOSE_PIXELS) {
        finishDraft();
        return;
      }
    }
    setDraft([...draft, corner]);
  };

  const blocked = splitBlocked(buildings, groups, preview, previewError);
  const unassigned = preview?.unassigned_total ?? 0;
  const run = async () => {
    if (blocked || running) return;
    setRunning(true);
    try {
      setResult(await splitSession(sessionId, splitShapes(buildings, groups)));
    } catch (error) {
      handleApiError(error, t("Could not split the import", "取り込みを分割できませんでした"), {
        title: t("Not split", "分割できませんでした")
      });
    } finally {
      setRunning(false);
    }
  };

  if (result) {
    return <SplitDone sessionId={sessionId} result={result} />;
  }

  const count = buildings.length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 items-start gap-8 overflow-auto px-14 pb-6 pt-7">
        <main className="flex min-w-0 flex-1 flex-col gap-4">
          <h1 className="font-display text-[30px] font-semibold leading-tight text-foreground">
            {t("Split into buildings", "建物ごとに分割")}
          </h1>
          <p className="max-w-[46rem] text-[15px] leading-[1.55] text-muted-foreground">
            {t(
              "Draw a shape over each building, or pick its layers or groups. A picked layer goes wholly to its building; any other feature goes to the shape its centre falls inside, on every floor. Step through the floors to check. Each building becomes its own project, set up and delivered on its own. This import stays as it is.",
              "建物ごとに図形を描くか、レイヤーやグループを選んでください。選んだレイヤーはすべてその建物に入り、それ以外の図形は中心がある図形の建物に、すべての階で入ります。階を切り替えて確認してください。建物ごとに別のプロジェクトになり、それぞれ設定・納品します。この取り込みはそのまま残ります。"
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <FloorChip selected={floor === null} onClick={() => setFloor(null)}>
              {t("All floors", "すべての階")}
            </FloorChip>
            {floors.map((item) => (
              <FloorChip key={item.ordinal} selected={floor === item.ordinal} onClick={() => setFloor(item.ordinal)}>
                {item.label}
              </FloorChip>
            ))}
            <div className="ml-auto flex items-center gap-2">
              {draft ? (
                <>
                  <span className="text-xs text-muted-foreground">
                    {t(
                      "Click the corners. Click the first corner or press Enter to finish; Esc cancels.",
                      "角をクリックします。最初の角をクリックするか Enter で完了、Esc で取り消し。"
                    )}
                  </span>
                  <Button size="sm" variant="outline" onClick={() => setDraft(null)}>
                    {t("Cancel", "取り消し")}
                  </Button>
                  <Button size="sm" disabled={draft.length < 3} onClick={finishDraft}>
                    {t("Finish shape", "図形を完成")}
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="outline" onClick={addPickedBuilding}>
                    <Layers aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                    {t("Pick layers for a building", "レイヤーで建物を指定")}
                  </Button>
                  <Button size="sm" onClick={() => setDraft([])}>
                    <Pencil aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                    {t("Draw a building", "建物を描く")}
                  </Button>
                </>
              )}
            </div>
          </div>
          <div className="h-[560px] overflow-hidden rounded-[10px] border border-border" data-testid="split-map">
            <MapView
              ref={mapRef}
              initialViewState={{ longitude: 139.76, latitude: 35.68, zoom: 14 }}
              mapStyle={STREET_MAP_STYLE}
              onLoad={fitAll}
              onClick={onMapClick}
              doubleClickZoom={!draft}
              cursor={draft ? "crosshair" : "grab"}
            >
              <Source id="split-features" type="geojson" data={shownFeatures as never}>
                <Layer
                  id="split-fill"
                  type="fill"
                  filter={["==", ["geometry-type"], "Polygon"]}
                  paint={{ "fill-color": featureColour, "fill-opacity": ["match", ["get", "split_role"], "active", 0.45, "other", 0.22, 0.35] }}
                />
                <Layer
                  id="split-line"
                  type="line"
                  filter={["!=", ["geometry-type"], "Point"]}
                  paint={{ "line-color": featureColour, "line-width": 1.2 }}
                />
                <Layer
                  id="split-point"
                  type="circle"
                  filter={["==", ["geometry-type"], "Point"]}
                  paint={{ "circle-color": featureColour, "circle-radius": 3.5, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1 }}
                />
              </Source>
              <Source id="split-outlines" type="geojson" data={outlines as never}>
                <Layer
                  id="split-outline"
                  type="line"
                  paint={{
                    "line-color": ["get", "colour"],
                    "line-width": ["case", ["get", "active"], 4, 2.5],
                    "line-dasharray": [3, 2]
                  }}
                />
              </Source>
              <Source id="split-draft" type="geojson" data={draftData as never}>
                <Layer id="split-draft-line" type="line" paint={{ "line-color": draftColour, "line-width": 2 }} />
                <Layer
                  id="split-draft-corner"
                  type="circle"
                  filter={["==", ["geometry-type"], "Point"]}
                  paint={{ "circle-color": draftColour, "circle-radius": 4, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5 }}
                />
              </Source>
            </MapView>
          </div>
          <p className="text-xs text-muted-foreground">
            {buildings.map((building, index) => (
              <Legend key={building.key} colour={buildingColour(building.key)}>
                {building.name.trim() || `#${index + 1}`}
              </Legend>
            ))}
            <Legend colour={colours.outside}>{t("Outside every building", "どの建物にも入らない")}</Legend>
          </p>
        </main>
        <aside className="flex w-[360px] shrink-0 flex-col gap-4">
          <section
            aria-label={t("Buildings", "建物")}
            className="flex flex-col gap-3 rounded-[14px] border border-border bg-card p-5"
          >
            <h2 className="text-[15px] font-semibold text-foreground">{t("Buildings", "建物")}</h2>
            {count === 0 ? (
              <p className="text-xs leading-[1.45] text-muted-foreground">
                {t(
                  "Draw a shape over a building, or pick its layers, to start.",
                  "建物の上に図形を描くか、そのレイヤーを選んで始めます。"
                )}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {buildings.map((building, index) => {
                  const counts = preview?.shapes[index];
                  const perFloor = counts ? countsByFloor(counts.files, floorOf) : null;
                  const isActive = building.key === active;
                  const picked = pickedStems(building, groups);
                  return (
                    <li
                      key={building.key}
                      className={cn(
                        "flex flex-col gap-2 rounded-[10px] border border-l-4 p-3",
                        isActive ? "bg-accent/40 ring-1 ring-primary" : "border-border"
                      )}
                      style={{ borderLeftColor: buildingColour(building.key) }}
                      data-colour={buildingColour(building.key)}
                      onClick={() => setActive(building.key)}
                    >
                      <div className="flex items-center gap-2">
                        <Input
                          aria-label={t(`Name of building ${index + 1}`, `建物 ${index + 1} の名前`)}
                          placeholder={t("Building name", "建物名")}
                          value={building.name}
                          onFocus={() => setActive(building.key)}
                          onChange={(event) =>
                            setBuildings((previous) =>
                              previous.map((item) => (item.key === building.key ? { ...item, name: event.target.value } : item))
                            )
                          }
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={t("Remove this building", "この建物を削除")}
                          onClick={(event) => {
                            event.stopPropagation();
                            setBuildings((previous) => previous.filter((item) => item.key !== building.key));
                          }}
                        >
                          <Trash2 aria-hidden="true" className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-mono text-xs text-muted-foreground">
                          {[
                            building.corners ? t("shape", "図形") : null,
                            picked.length ? t(`${picked.length} picked`, `選択 ${picked.length}`) : null,
                            counts ? t(featureCount(counts.total), `${counts.total} 件`) : notYet ? null : t("Counting…", "集計中…")
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                        <Button
                          size="sm"
                          variant={isActive && picking ? "secondary" : "ghost"}
                          aria-pressed={isActive && picking}
                          onClick={(event) => {
                            event.stopPropagation();
                            setActive(building.key);
                            setPicking(!(isActive && picking));
                          }}
                        >
                          <Layers aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                          {t("Layers", "レイヤー")}
                        </Button>
                      </div>
                      {perFloor && perFloor.size > 0 ? (
                        <ul className="flex flex-wrap gap-1.5">
                          {[...perFloor.entries()]
                            .sort(([a], [b]) => (a ?? -999) - (b ?? -999))
                            .map(([ordinal, n]) => (
                              <li key={String(ordinal)} className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-foreground">
                                {ordinal === null
                                  ? t("no floor", "階なし")
                                  : floors.find((item) => item.ordinal === ordinal)?.label ?? ordinal}{" "}
                                · {n}
                              </li>
                            ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          {picking && activeIndex >= 0 ? (
            <LayerPicker
              index={activeIndex}
              buildings={buildings}
              files={files}
              groups={groups}
              onChange={(change) => updateBuilding(buildings[activeIndex].key, change)}
              onClose={() => setPicking(false)}
            />
          ) : null}
          {preview && unassigned > 0 ? (
            <section
              aria-label={t("Left out", "対象外")}
              className="flex flex-col gap-2 rounded-[14px] border border-border bg-card p-5"
            >
              <h2 className="text-[15px] font-semibold text-foreground">
                {t(`${unassigned} left out`, `対象外 ${unassigned} 件`)}
              </h2>
              <p className="text-xs leading-[1.45] text-muted-foreground">
                {t(
                  "No building picked their layer and their centres are outside every shape, so no new project gets them. Widen a shape or pick the layer if they belong to one.",
                  "どの建物もそのレイヤーを選んでおらず、中心がどの図形の外にもあるため、どのプロジェクトにも入りません。必要なら図形を広げるか、レイヤーを選んでください。"
                )}
              </p>
              <ul className="flex flex-col gap-1 text-xs">
                {Object.entries(preview.unassigned).map(([stem, n]) => {
                  const type = files.find((file) => file.stem === stem)?.detected_type ?? "";
                  const label = TYPE_LABELS[type];
                  return (
                    <li key={stem} className="flex justify-between gap-2">
                      <span className="truncate font-mono text-foreground" title={stem}>
                        {stem}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {label ? `${t(label.en, label.ja)} · ` : ""}
                        {n}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>
      <NextBar
        step={{
          title:
            count === 0
              ? { en: "No buildings yet", ja: "まだ建物がありません" }
              : { en: `${count} ${count === 1 ? "project" : "projects"} will be made`, ja: `${count} 件のプロジェクトを作成します` },
          detail: {
            en: "Each opens at Bring in, with this import’s files and floors already confirmed.",
            ja: "それぞれ、この取り込みのファイルと階が確認済みの状態で「取り込み」から始まります。"
          },
          action: { en: count === 1 ? "Make 1 project" : `Make ${count} projects`, ja: "プロジェクトを作成" },
          blocked: running ? { en: "Splitting…", ja: "分割中…" } : blocked
        }}
        onGo={() => void run()}
        secondary={
          <Button variant="ghost" className="text-primary" asChild>
            <Link to={projectPath(sessionId, "bring-in")}>{t("Back to Bring in", "取り込みへ戻る")}</Link>
          </Button>
        }
      />
    </div>
  );
}

function featureCount(n: number): string {
  return `${n} ${n === 1 ? "feature" : "features"}`;
}

/** The layers and groups picked for one building; a file another building picked cannot be ticked here. */
function LayerPicker({
  index,
  buildings,
  files,
  groups,
  onChange,
  onClose
}: {
  index: number;
  buildings: ReadonlyArray<Building>;
  files: ReadonlyArray<ImportedFile>;
  groups: ReadonlyArray<LayerGroup>;
  onChange: (change: (building: Building) => Building) => void;
  onClose: () => void;
}) {
  const { t } = useUiLanguage();
  const [query, setQuery] = useState("");
  const building = buildings[index];
  const label = building.name.trim() || `#${index + 1}`;
  const owners = useMemo(() => pickOwners(buildings, groups), [buildings, groups]);
  const viaGroup = useMemo(
    () => new Set(pickedStems({ ...building, files: [] }, groups)),
    [building, groups]
  );
  const shownGroups = filterGroups(groups, query);
  const shownFiles = filterFiles(files, query);
  const takenBy = (stem: string) =>
    (owners.get(stem) ?? []).filter((owner) => owner !== index).map((owner) => buildings[owner].name.trim() || `#${owner + 1}`);
  const free = shownFiles.filter((file) => takenBy(file.stem).length === 0 && !viaGroup.has(file.stem));
  const toggle = (key: "files" | "groups", id: string) =>
    onChange((item) => ({
      ...item,
      [key]: item[key].includes(id) ? item[key].filter((value) => value !== id) : [...item[key], id]
    }));

  return (
    <section
      aria-label={t(`Layers for ${label}`, `${label} のレイヤー`)}
      className="flex flex-col gap-3 rounded-[14px] border border-border bg-card p-5"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-foreground">{t(`Layers for ${label}`, `${label} のレイヤー`)}</h2>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("Done", "完了")}
        </Button>
      </div>
      <p className="text-xs leading-[1.45] text-muted-foreground">
        {t(
          "Every feature of a ticked layer goes to this building, wherever it lies. A layer can go to one building only.",
          "チェックしたレイヤーの図形は、位置に関係なくすべてこの建物に入ります。1 つのレイヤーは 1 つの建物にしか入れられません。"
        )}
      </p>
      <Input
        aria-label={t("Filter layers", "レイヤーを絞り込む")}
        placeholder={t("Filter, e.g. JRShinjukuSta", "絞り込み（例: JRShinjukuSta）")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {shownGroups.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold text-foreground">{t("Groups", "グループ")}</h3>
          <ul className="flex max-h-[200px] flex-col gap-0.5 overflow-auto">
            {shownGroups.map((group) => (
              <li key={group.id}>
                <label className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-primary"
                    checked={building.groups.includes(group.id)}
                    onChange={() => toggle("groups", group.id)}
                  />
                  <span className="min-w-0 flex-1 truncate text-foreground" title={group.name}>
                    {group.name}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {group.kind === "feature_dataset" ? t("dataset", "データセット") : t("map group", "マップのグループ")} ·{" "}
                    {group.stems.length}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-foreground">
            {t(`Layers · ${shownFiles.length}`, `レイヤー · ${shownFiles.length}`)}
          </h3>
          <span className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={free.every((file) => building.files.includes(file.stem))}
              onClick={() =>
                onChange((item) => ({ ...item, files: [...new Set([...item.files, ...free.map((file) => file.stem)])] }))
              }
            >
              {t("Tick all shown", "表示中をすべて選択")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!shownFiles.some((file) => building.files.includes(file.stem))}
              onClick={() => {
                const shown = new Set(shownFiles.map((file) => file.stem));
                onChange((item) => ({ ...item, files: item.files.filter((stem) => !shown.has(stem)) }));
              }}
            >
              {t("Untick shown", "表示中を解除")}
            </Button>
          </span>
        </div>
        <ul className="flex max-h-[320px] flex-col gap-0.5 overflow-auto">
          {shownFiles.map((file) => {
            const others = takenBy(file.stem);
            const inGroup = viaGroup.has(file.stem);
            return (
              <li key={file.stem}>
                <label className={cn("flex items-start gap-2 text-xs", others.length > 0 && "opacity-60")}>
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-primary"
                    checked={inGroup || building.files.includes(file.stem)}
                    disabled={inGroup || (others.length > 0 && !building.files.includes(file.stem))}
                    onChange={() => toggle("files", file.stem)}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={file.stem}>
                    {file.stem}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {inGroup ? `${t("in a group", "グループ内")} · ` : others.length ? `${others.join(", ")} · ` : ""}
                    {file.feature_count}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function FloorChip({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "rounded-full px-3 py-1 font-mono text-xs font-medium",
        selected ? "bg-primary text-primary-foreground" : "bg-muted text-foreground hover:bg-accent"
      )}
    >
      {children}
    </button>
  );
}

function Legend({ colour, children }: { colour: string; children: React.ReactNode }) {
  return (
    <span className="mr-4 inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: colour }} />
      {children}
    </span>
  );
}

function SplitDone({ sessionId, result }: { sessionId: string; result: SplitResponse }) {
  const { t } = useUiLanguage();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-14 pb-6 pt-7">
      <main className="flex max-w-[46rem] flex-col gap-4">
        <h1 className="font-display text-[30px] font-semibold leading-tight text-foreground">
          {t(`${result.projects.length} ${result.projects.length === 1 ? "project" : "projects"} made`, `${result.projects.length} 件のプロジェクトを作成しました`)}
        </h1>
        <p className="text-[15px] leading-[1.55] text-muted-foreground">
          {result.unassigned_total > 0
            ? t(
                `${featureCount(result.unassigned_total)} ${result.unassigned_total === 1 ? "was" : "were"} outside every building and went to none of them. The original import is unchanged.`,
                `${result.unassigned_total} 件はどの建物にも入らず、どのプロジェクトにも含まれていません。元の取り込みは変更されていません。`
              )
            : t("Every feature went to a building. The original import is unchanged.", "すべての図形がいずれかの建物に入りました。元の取り込みは変更されていません。")}
        </p>
        <ul className="flex flex-col gap-2">
          {result.projects.map((project) => (
            <li
              key={project.session_id}
              className="flex items-center justify-between gap-4 rounded-[10px] border border-border bg-card px-4 py-3"
            >
              <div className="flex flex-col">
                <span className="font-semibold text-foreground">{project.name}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {t(featureCount(project.feature_count), `${project.feature_count} 件`)}
                </span>
              </div>
              <Button size="sm" asChild>
                <Link to={projectPath(project.session_id, "bring-in")}>{t("Open", "開く")}</Link>
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/">{t("All projects", "プロジェクト一覧")}</Link>
          </Button>
          <Button variant="ghost" asChild>
            <Link to={projectPath(sessionId, "bring-in")}>{t("Back to this import", "この取り込みへ戻る")}</Link>
          </Button>
        </div>
      </main>
    </div>
  );
}
