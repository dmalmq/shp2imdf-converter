import { floorsNeedingArtworkMatch, preferredArtworkMatchTarget } from "./artworkMatch";
import type { IllustratorPageAlignment } from "../api/client";

const ALIGNED: IllustratorPageAlignment = {
  page: 2,
  anchor_page: 1,
  offset: [0, 0],
  rotation_deg: 0,
  scale: 1,
  overlap_iou: 1,
  matched_outlines: 5,
  aligned: true,
  reason: null
};

const FAILED: IllustratorPageAlignment = {
  ...ALIGNED,
  page: 4,
  aligned: false,
  overlap_iou: 0,
  matched_outlines: 0,
  reason: "no_consensus"
};

test("pages that failed to stack name their floors", () => {
  expect(
    floorsNeedingArtworkMatch(
      [
        { label: "1F", pages: [1] },
        { label: "2F", pages: [2] },
        { label: "3F", pages: [3] },
        { label: "4F", pages: [4] }
      ],
      [
        { ...ALIGNED, page: 2 },
        { ...ALIGNED, page: 3 },
        FAILED
      ]
    )
  ).toEqual(["4F"]);
});

test("a whole-artwork skip has no unstacked floor", () => {
  expect(floorsNeedingArtworkMatch([{ label: "artwork", pages: null }], [FAILED])).toEqual([]);
});

test("4F matches onto 3F", () => {
  const floors = ["1F", "2F", "3F", "4F"].map((label) => ({
    label,
    artworkMatch: label === "4F"
  }));
  expect(preferredArtworkMatchTarget("4F", floors)).toBe("3F");
});

test("a floor without an F number uses the last stacked floor", () => {
  expect(
    preferredArtworkMatchTarget("ペリエ", [
      { label: "1F" },
      { label: "2F" },
      { label: "3F" },
      { label: "ペリエ", artworkMatch: true }
    ])
  ).toBe("3F");
});
