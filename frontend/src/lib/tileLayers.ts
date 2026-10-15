import type { TileLayerNode, TileLayers, TileMap } from "../api/client";

/** The uRIs of the layers to tile. Groups are never in it: a group's tick is read off the layers inside it. */
export type TileChoice = ReadonlySet<string>;

export type TileMaps = Extract<TileLayers, { state: "maps" }>;

/** The map to tile, by id, and the layers of it to tile. */
export type TileSelection = { map: string; layers: TileChoice };

/** The server only lists a map it can tile from, so a lookup by an id it gave always finds one. */
export function tileMap(maps: TileMaps, id: string): TileMap {
  const found = maps.maps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No map ${id} in the project`);
  return found;
}

/** A map whose groups hold no layer has nothing to tile and cannot be chosen. */
export function mapLayerCount(map: TileMap): number {
  return [...layersIn(map.layers)].length;
}

/** What the server would tile with nothing sent but, optionally, the map: that map's own defaults. */
export function defaultTileSelection(maps: TileMaps, id: string = maps.default_map): TileSelection {
  return { map: id, layers: defaultTileChoice(tileMap(maps, id).layers) };
}

export type TickState = boolean | "indeterminate";

function* layersIn(nodes: readonly TileLayerNode[]): Generator<TileLayerNode> {
  for (const node of nodes) {
    if (node.group) yield* layersIn(node.children);
    else yield node;
  }
}

function* groupsIn(nodes: readonly TileLayerNode[]): Generator<TileLayerNode> {
  for (const node of nodes) {
    if (!node.group) continue;
    yield node;
    yield* groupsIn(node.children);
  }
}

/** What the server would tile with nothing sent: the project as saved, less the pattern file's matches. */
export function defaultTileChoice(nodes: readonly TileLayerNode[]): TileChoice {
  return new Set([...layersIn(nodes)].filter((layer) => layer.tiled_by_default).map((layer) => layer.uri));
}

/** A layer's tick, or a group's from the layers inside it; a group with no layers is never ticked. */
export function tickState(node: TileLayerNode, choice: TileChoice): TickState {
  if (!node.group) return choice.has(node.uri);
  const layers = [...layersIn(node.children)];
  const ticked = layers.filter((layer) => choice.has(layer.uri)).length;
  if (ticked === 0) return false;
  return ticked === layers.length ? true : "indeterminate";
}

/** Ticking a group ticks every layer in it; unticking unticks them all. */
export function setTicked(choice: TileChoice, node: TileLayerNode, ticked: boolean): TileChoice {
  const next = new Set(choice);
  for (const layer of node.group ? layersIn(node.children) : [node]) {
    if (ticked) next.add(layer.uri);
    else next.delete(layer.uri);
  }
  return next;
}

export type TileLayerCounts = {
  groups: number;
  layers: number;
  chosen: number;
  /** Layers a pattern takes out by default, by their own name or a group's above them. */
  excluded: number;
};

export function tileLayerCounts(nodes: readonly TileLayerNode[], choice: TileChoice): TileLayerCounts {
  const layers = [...layersIn(nodes)];
  return {
    groups: [...groupsIn(nodes)].length,
    layers: layers.length,
    chosen: layers.filter((layer) => choice.has(layer.uri)).length,
    excluded: excludedLayers(nodes).size
  };
}

function excludedLayers(nodes: readonly TileLayerNode[], inherited = false): Set<string> {
  const out = new Set<string>();
  for (const node of nodes) {
    const excluded = inherited || node.excluded_by !== null;
    if (node.group) for (const uri of excludedLayers(node.children, excluded)) out.add(uri);
    else if (excluded) out.add(node.uri);
  }
  return out;
}

/**
 * A kind of layer the defaults leave out, to tick or untick at once: those an exclusion pattern names,
 * by their own name or a group's above them, and those that draw points. A layer can be of several kinds.
 */
export type TileLayerKind = { kind: "pattern"; pattern: string; layers: readonly string[] } | { kind: "points"; layers: readonly string[] };

/** The kinds present in `nodes`: patterns in the order the tree first shows them, then points. */
export function tileLayerKinds(nodes: readonly TileLayerNode[]): TileLayerKind[] {
  const byPattern = new Map<string, string[]>();
  const points: string[] = [];
  const visit = (list: readonly TileLayerNode[], inherited: ReadonlySet<string>) => {
    for (const node of list) {
      const patterns = node.excluded_by === null ? inherited : new Set([...inherited, node.excluded_by]);
      if (node.group) {
        visit(node.children, patterns);
        continue;
      }
      for (const pattern of patterns) byPattern.set(pattern, [...(byPattern.get(pattern) ?? []), node.uri]);
      if (node.draws_points) points.push(node.uri);
    }
  };
  visit(nodes, new Set());
  const kinds: TileLayerKind[] = [...byPattern].map(([pattern, layers]) => ({ kind: "pattern", pattern, layers }));
  return points.length > 0 ? [...kinds, { kind: "points", layers: points }] : kinds;
}

/** Ticked when all of its layers are, unticked when none are. */
export function kindTickState(kind: TileLayerKind, choice: TileChoice): TickState {
  const ticked = kind.layers.filter((uri) => choice.has(uri)).length;
  if (ticked === 0) return false;
  return ticked === kind.layers.length ? true : "indeterminate";
}

export function setKindTicked(choice: TileChoice, kind: TileLayerKind, ticked: boolean): TileChoice {
  const next = new Set(choice);
  for (const uri of kind.layers) {
    if (ticked) next.add(uri);
    else next.delete(uri);
  }
  return next;
}

/** The choice in the project's drawing order, as it is sent. */
export function choiceInOrder(nodes: readonly TileLayerNode[], choice: TileChoice): string[] {
  return [...layersIn(nodes)].filter((layer) => choice.has(layer.uri)).map((layer) => layer.uri);
}
