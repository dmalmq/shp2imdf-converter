import React, { useEffect } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { fetchIllustratorConversion, type IllustratorConversionResponse } from "../api/client";
import type * as ApiClient from "../api/client";
import { buildApiClientError } from "../api/errors";
import { ArtworkRoute } from "./ArtworkRoute";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  fetchIllustratorConversion: vi.fn()
}));

const mounts = vi.fn();

vi.mock("./IllustratorPage", () => ({
  IllustratorPage: ({
    restored,
    onConversion
  }: {
    restored?: IllustratorConversionResponse;
    onConversion?: (id: string) => void;
  }) => {
    useEffect(() => {
      mounts();
    }, []);
    return (
      <section>
        <output data-testid="restored">{restored?.conversion_id ?? "none"}</output>
        <button type="button" onClick={() => onConversion?.("c".repeat(32))}>
          Convert
        </button>
      </section>
    );
  }
}));

const fetchConversion = vi.mocked(fetchIllustratorConversion);

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function GoNew() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/illustrator")}>
      New
    </button>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/illustrator" element={<ArtworkRoute />} />
        <Route path="/a/:conversionId" element={<ArtworkRoute />} />
        <Route path="/" element={<p>Hub</p>} />
      </Routes>
      <Where />
      <GoNew />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mounts.mockReset();
  fetchConversion.mockReset();
});

test("a conversion made at /illustrator replaces the URL and keeps the same page", async () => {
  renderAt("/illustrator");
  expect(mounts).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Convert" }));

  expect(await screen.findByTestId("where")).toHaveTextContent(`/a/${"c".repeat(32)}`);
  expect(mounts).toHaveBeenCalledTimes(1);
  expect(fetchConversion).not.toHaveBeenCalled();
  expect(screen.getByTestId("restored")).toHaveTextContent("none");
});

test("a new artwork after a created one starts a fresh page", async () => {
  renderAt("/illustrator");
  fireEvent.click(screen.getByRole("button", { name: "Convert" }));
  await screen.findByText(`/a/${"c".repeat(32)}`);

  fireEvent.click(screen.getByRole("button", { name: "New" }));

  expect(await screen.findByTestId("where")).toHaveTextContent("/illustrator");
  expect(mounts).toHaveBeenCalledTimes(2);
});

test("/a/:id reopens the stored conversion", async () => {
  const id = "d".repeat(32);
  fetchConversion.mockResolvedValue({ conversion_id: id } as IllustratorConversionResponse);
  renderAt(`/a/${id}`);

  expect(await screen.findByTestId("restored")).toHaveTextContent(id);
  expect(fetchConversion).toHaveBeenCalledWith(id);
});

test("an expired or unknown id says it is no longer on this PC, with a way back", async () => {
  fetchConversion.mockRejectedValue(
    buildApiClientError(404, JSON.stringify({ detail: "gone", code: "CONVERSION_EXPIRED" }))
  );
  renderAt("/a/..%5Cvictim");

  expect(
    await screen.findByRole("heading", { name: "This artwork project is no longer on this PC" })
  ).toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getByRole("link", { name: "Back to projects" }));
  });
  expect(screen.getByText("Hub")).toBeInTheDocument();
});

test("another failure offers a retry", async () => {
  fetchConversion.mockRejectedValueOnce(new Error("boom"));
  fetchConversion.mockResolvedValueOnce({ conversion_id: "e".repeat(32) } as IllustratorConversionResponse);
  renderAt(`/a/${"e".repeat(32)}`);

  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

  expect(await screen.findByTestId("restored")).toHaveTextContent("e".repeat(32));
});
