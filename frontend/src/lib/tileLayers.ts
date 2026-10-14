import type { TileLayerNode } from "../api/client";

/** The uRIs of the layers to tile. Groups are never in it: a group's tick is read off the layers inside it. */
export type TileChoice = ReadonlySet<string>;

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

/** The choice in the project's drawing order, as it is sent. */
export function choiceInOrder(nodes: readonly TileLayerNode[], choice: TileChoice): string[] {
  return [...layersIn(nodes)].filter((layer) => choice.has(layer.uri)).map((layer) => layer.uri);
}
