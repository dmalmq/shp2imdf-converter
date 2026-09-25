import React from "react";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";

import { useDroppedFiles } from "./useDroppedFiles";

let navigate: NavigateFunction;
let handedOver: File[][] = [];

function Page() {
  handedOver.push(useDroppedFiles());
  const location = useLocation();
  navigate = useNavigate();
  return <p data-testid="state">{location.state === null ? "no state" : "state"}</p>;
}

function Other() {
  navigate = useNavigate();
  return <p>elsewhere</p>;
}

beforeEach(() => {
  handedOver = [];
});

test("the files are handed over once, and the history entry forgets them", async () => {
  const file = new File(["x"], "0001_東京.ai");
  render(
    <MemoryRouter initialEntries={[{ pathname: "/illustrator", state: { droppedFiles: [file] } }]}>
      <Routes>
        <Route path="/illustrator" element={<Page />} />
        <Route path="/other" element={<Other />} />
      </Routes>
    </MemoryRouter>
  );

  expect(await screen.findByText("no state")).toBeInTheDocument();
  expect(handedOver.every((files) => files.length === 1 && files[0] === file)).toBe(true);

  act(() => navigate("/other"));
  await screen.findByText("elsewhere");
  handedOver = [];
  act(() => navigate(-1));
  await screen.findByText("no state");
  expect(handedOver.every((files) => files.length === 0)).toBe(true);
});
