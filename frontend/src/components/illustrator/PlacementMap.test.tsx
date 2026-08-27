import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import type { Polygon } from "geojson";

import type { IllustratorShapeMatchSuggestion } from "../../api/client";

import {
  DEFAULT_METRES_PER_POINT,
  type ControlPoint,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { artworkToLngLat, type SimilarityTransform } from "../../lib/similarity";
import {
  buildControlPointOverlay,
  buildRegionOverlay,
  buildShapeMatchOverlay,
  PlacementMap,
  resolvePickedOutline,
  type ArtworkShapeSelection,
  type FloorLayer
} from "./PlacementMap";


function stateWith(floors: { label: string; linked: boolean }[], active: string): PlacementState {
  return {
    frame: { rotationDeg: 0, metresPerPoint: DEFAULT_METRES_PER_POINT, workingCrs: "EPSG:6677" },
    activeFloorLabel: active,
    scaleLocked: false,
    floors: floors.map((floor) => ({
      label: floor.label,
      linked: floor.linked,
      artworkAnchor: [50, 50] as [number, number],
      mapAnchor: [139.7671, 35.6812] as [number, number],
      controlPoints: [],
      artworkBounds: [0, 0, 100, 100] as [number, number, number, number]
    }))
  };
}

const LAYERS: FloorLayer[] = [
  { label: "1F", features: [], bounds: [0, 0, 1, 1], color: "#3b82f6" },
  { label: "2F", features: [], bounds: [0, 0, 1, 1], color: "#16a34a" }
];


test("an unlinked floor carries the unlinked marker in its accessible name", () => {
  render(
    <PlacementMap
      mode="group"
      onModeChange={() => {}}
      floors={LAYERS}
      state={stateWith(
        [
          { label: "1F", linked: true },
          { label: "2F", linked: false }
        ],
        "1F"
      )}
      dispatch={() => {}}
      pickStage={null}
      onPickArtwork={() => {}}
      onPickMap={() => {}}
    />
  );
  // The deleted dropdown announced "(unlinked)"; the pill must keep that
  // signal in the accessible name, not just in a tooltip or a dot.
  expect(screen.getByRole("button", { name: /unlinked/i })).toBeInTheDocument();
  // Linked pills keep their plain label as the name — no aria-label noise.
  expect(screen.getByRole("button", { name: "1F" })).toBeInTheDocument();
});

test("the pill for the active floor announces its pressed state", () => {
  render(
    <PlacementMap
      mode="group"
      onModeChange={() => {}}
      floors={LAYERS}
      state={stateWith(
        [
          { label: "1F", linked: true },
          { label: "2F", linked: false }
        ],
        "1F"
      )}
      dispatch={() => {}}
      pickStage={null}
      onPickArtwork={() => {}}
      onPickMap={() => {}}
    />
  );
  // The deleted dropdown announced its current value; the pills are the only
  // floor control now, so the active one must be exposed as a state, not as
  // a purely visual colour change. Asserted via the accessible state, not an
  // attribute string.
  expect(screen.getByRole("button", { name: "1F", pressed: true })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /unlinked/i, pressed: false })).toBeInTheDocument();
});

const ONE_LAYER: FloorLayer[] = [
  { label: "1F", features: [], bounds: [0, 0, 1, 1], color: "#3b82f6" }
];

function renderMap(layers: FloorLayer[], floors: { label: string; linked: boolean }[]) {
  render(
    <PlacementMap
      mode="group"
      onModeChange={() => {}}
      floors={layers}
      state={stateWith(floors, floors[0].label)}
      dispatch={() => {}}
      pickStage={null}
      onPickArtwork={() => {}}
      onPickMap={() => {}}
    />
  );
}


test("the isolate toggle starts off, so ghost floors stay visible by default", () => {
  renderMap(LAYERS, [
    { label: "1F", linked: true },
    { label: "2F", linked: true }
  ]);
  expect(
    screen.getByRole("button", { name: /only this floor/i, pressed: false })
  ).toBeInTheDocument();
});

test("clicking the isolate toggle flips its pressed state", () => {
  renderMap(LAYERS, [
    { label: "1F", linked: true },
    { label: "2F", linked: true }
  ]);
  fireEvent.click(screen.getByRole("button", { name: /only this floor/i }));
  expect(
    screen.getByRole("button", { name: /only this floor/i, pressed: true })
  ).toBeInTheDocument();
});

test("no isolate toggle with a single floor — there are no ghosts to hide", () => {
  renderMap(ONE_LAYER, [{ label: "1F", linked: true }]);
  expect(screen.queryByRole("button", { name: /only this floor/i })).toBeNull();
});

test("the Group/Individual switch reflects the mode and reports changes", () => {
  const seen: string[] = [];
  render(
    <PlacementMap
      floors={LAYERS}
      state={stateWith(
        [
          { label: "1F", linked: true },
          { label: "2F", linked: true }
        ],
        "1F"
      )}
      dispatch={() => {}}
      mode="group"
      onModeChange={(mode) => seen.push(mode)}
      pickStage={null}
      onPickArtwork={() => {}}
      onPickMap={() => {}}
    />
  );
  // Group is the default posture: the building aligns as one first.
  expect(screen.getByRole("button", { name: "Group", pressed: true })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Individual", pressed: false })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Individual" }));
  expect(seen).toEqual(["individual"]);
});

test("no mode switch with a single floor — there is nothing to group", () => {
  renderMap(ONE_LAYER, [{ label: "1F", linked: true }]);
  expect(screen.queryByRole("button", { name: "Individual" })).toBeNull();
});


test("switching floor, isolate, and Individual does not unmount the map wrapper", () => {
  const { container } = render(
    <PlacementMap
      floors={LAYERS}
      state={stateWith(
        [
          { label: "1F", linked: true },
          { label: "2F", linked: true }
        ],
        "1F"
      )}
      dispatch={() => {}}
      mode="group"
      onModeChange={() => {}}
      pickStage={null}
      onPickArtwork={() => {}}
      onPickMap={() => {}}
    />
  );
  const wrapper = container.firstChild;
  fireEvent.click(screen.getByRole("button", { name: "2F" }));
  fireEvent.click(screen.getByRole("button", { name: /only this floor/i }));
  fireEvent.click(screen.getByRole("button", { name: "Individual" }));
  expect(container.firstChild).toBe(wrapper);
});

test("buildControlPointOverlay pairs artwork, reference, and residual features", () => {
  const transform: SimilarityTransform = {
    artworkAnchor: [10, 20],
    mapAnchor: [139.7, 35.69],
    rotationDeg: 90,
    metresPerPoint: 0.5,
    workingCrs: "EPSG:6677"
  };
  const controlPoints: ControlPoint[] = [
    { id: "a", artwork: [10, 20], map: [139.7001, 35.6901] },
    { id: "b", artwork: [110, 20], map: [139.7002, 35.6902] }
  ];

  const overlay = buildControlPointOverlay(controlPoints, transform);
  expect(overlay.features).toHaveLength(controlPoints.length * 3);
  expect(
    overlay.features.reduce<Record<string, number>>((counts, feature) => {
      const kind = String(feature.properties?.kind);
      counts[kind] = (counts[kind] ?? 0) + 1;
      return counts;
    }, {})
  ).toEqual({ residual: 2, artwork: 2, reference: 2 });

  controlPoints.forEach((point, index) => {
    const label = String(index + 1);
    const artworkCoordinates = artworkToLngLat(
      transform,
      point.artwork[0],
      point.artwork[1]
    );
    const residual = overlay.features.find(
      (feature) => feature.properties?.kind === "residual" && feature.properties.label === label
    );
    const artwork = overlay.features.find(
      (feature) => feature.properties?.kind === "artwork" && feature.properties.label === label
    );
    const reference = overlay.features.find(
      (feature) => feature.properties?.kind === "reference" && feature.properties.label === label
    );

    expect(artwork?.geometry).toEqual({ type: "Point", coordinates: artworkCoordinates });
    expect(reference?.geometry).toEqual({ type: "Point", coordinates: point.map });
    expect(residual?.geometry).toEqual({
      type: "LineString",
      coordinates: [artworkCoordinates, point.map]
    });
  });
});

test("buildShapeMatchOverlay keeps current, proposed, reference, and residual geometry distinct", () => {
  const selection: ArtworkShapeSelection = {
    floorLabel: "1F",
    sourceTable: "Fill_Layer",
    sourceRow: 0,
    feature: {
      type: "Feature",
      properties: { source_table: "Fill_Layer", source_row: 0 },
      geometry: {
        type: "Polygon",
        coordinates: [[[0, 0], [100, 0], [100, 80], [0, 80], [0, 0]]]
      }
    }
  };
  const current: SimilarityTransform = {
    artworkAnchor: [50, 40],
    mapAnchor: [139.7, 35.69],
    rotationDeg: 0,
    metresPerPoint: 0.3,
    workingCrs: "EPSG:6677"
  };
  const proposed: SimilarityTransform = {
    ...current,
    mapAnchor: [139.701, 35.691],
    rotationDeg: 25,
    metresPerPoint: 0.45
  };
  const suggestion: IllustratorShapeMatchSuggestion = {
    rank: 1,
    score: 0.1,
    relative_gap: 0.2,
    reference_feature_index: 3,
    reference_part_index: 0,
    transform: {
      artwork_anchor: proposed.artworkAnchor,
      map_anchor: proposed.mapAnchor,
      rotation_deg: proposed.rotationDeg,
      metres_per_point: proposed.metresPerPoint,
      working_crs: proposed.workingCrs
    },
    boundary_rmse_m: 1,
    boundary_p95_m: 2,
    max_residual_m: 3,
    overlap_iou: 0.9,
    reference_geometry: {
      type: "Polygon",
      coordinates: [
        [
          [139.7008, 35.6908],
          [139.7012, 35.6908],
          [139.7012, 35.6912],

          [139.7008, 35.6912],
          [139.7008, 35.6908]
        ]
      ]
    },
    residual_vectors: [
      {
        artwork: [139.7009, 35.6909],
        reference: [139.701, 35.691],
        distance_m: 1.2
      }
    ]
  };
  const overlay = buildShapeMatchOverlay(selection, current, { suggestion, transform: proposed });
  expect(overlay.features.map((feature) => feature.properties?.kind)).toEqual([
    "selected",
    "reference",
    "preview",
    "residual"
  ]);
  expect(overlay.features.find((feature) => feature.properties?.kind === "reference")?.geometry).toEqual(
    suggestion.reference_geometry
  );
  expect(overlay.features.find((feature) => feature.properties?.kind === "residual")?.geometry).toEqual({
    type: "LineString",
    coordinates: [
      [139.7009, 35.6909],
      [139.701, 35.691]
    ]
  });
  const selected = overlay.features.find((feature) => feature.properties?.kind === "selected");
  const previewed = overlay.features.find((feature) => feature.properties?.kind === "preview");
  expect(selected?.geometry).not.toEqual(previewed?.geometry);
});

const ROOM = {
  type: "Feature" as const,
  properties: { source_table: "Rooms", source_row: 0 },
  geometry: {
    type: "Polygon" as const,
    coordinates: [[[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]]
  }
};
const NEIGHBOUR = {
  type: "Feature" as const,
  properties: { source_table: "Rooms", source_row: 1 },
  geometry: {
    type: "Polygon" as const,
    coordinates: [[[12, 0], [20, 0], [20, 8], [12, 8], [12, 0]]]
  }
};
const STROKE = {
  type: "Feature" as const,
  properties: { source_table: "Buildings__lines", source_row: 0 },
  geometry: {
    type: "LineString" as const,
    coordinates: [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]]
  }
};
const PICK_LAYER = [ROOM, NEIGHBOUR, STROKE];

test("an exact fill hit wins even when a stroked path is nearby", () => {
  expect(
    resolvePickedOutline(
      [{ geometry: ROOM.geometry, properties: ROOM.properties }],
      [
        { geometry: STROKE.geometry, properties: STROKE.properties },
        { geometry: NEIGHBOUR.geometry, properties: NEIGHBOUR.properties }
      ],
      PICK_LAYER
    )
  ).toBe(ROOM);
});

test("a nearby stroked path beats a neighbouring fill in the snap box", () => {
  expect(
    resolvePickedOutline(
      [],
      [
        { geometry: NEIGHBOUR.geometry, properties: NEIGHBOUR.properties },
        { geometry: STROKE.geometry, properties: STROKE.properties }
      ],
      PICK_LAYER
    )
  ).toBe(STROKE);
});

test("buildShapeMatchOverlay keeps a picked line as LineString selected geometry", () => {
  const overlay = buildShapeMatchOverlay(
    {
      floorLabel: "1F",
      sourceTable: "Buildings__lines",
      sourceRow: 0,
      feature: STROKE
    },
    {
      artworkAnchor: [20, 15],
      mapAnchor: [139.7, 35.69],
      rotationDeg: 0,
      metresPerPoint: 0.3,
      workingCrs: "EPSG:6677"
    }
  );
  expect(overlay.features).toHaveLength(1);
  expect(overlay.features[0]?.properties?.kind).toBe("selected");
  expect(overlay.features[0]?.geometry?.type).toBe("LineString");
});


test("buildRegionOverlay closes each picked area and tags which floor it came from", () => {
  const source: [number, number][] = [
    [139.766, 35.682],
    [139.768, 35.682],
    [139.768, 35.68],
    [139.766, 35.68]
  ];
  const target: [number, number][] = [
    [139.776, 35.692],
    [139.778, 35.692],
    [139.778, 35.69],
    [139.776, 35.69]
  ];
  const overlay = buildRegionOverlay(source, target);
  expect(overlay.features.map((feature) => feature.properties?.kind)).toEqual([
    "region-source",
    "region-target"
  ]);
  const ring = (overlay.features[0]?.geometry as Polygon).coordinates[0];
  expect(ring).toHaveLength(5);
  expect(ring[4]).toEqual(ring[0]);

  // Nothing drawn yet is an empty overlay, not a degenerate polygon.
  expect(buildRegionOverlay(null, null).features).toHaveLength(0);
});
