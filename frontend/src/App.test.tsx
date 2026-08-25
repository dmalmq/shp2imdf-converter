import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { importImdfShapefiles } from "./api/client";
import type * as ApiClient from "./api/client";
import App from "./App";

vi.mock("./api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  importImdfShapefiles: vi.fn()
}));


test("renders upload page heading", () => {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );

  expect(screen.getByText("Standard import")).toBeInTheDocument();
  expect(screen.getByText("IMDF-schema shapefiles")).toBeInTheDocument();
});

test("allows deselecting queued files before import", async () => {
  const queryClient = new QueryClient();
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );

  const importButton = screen.getByRole("button", { name: "Import & Continue" });
  expect(importButton).toBeDisabled();

  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
  expect(fileInput).not.toBeNull();

  const sample = new File(["shape"], "sample.shp", { type: "application/octet-stream" });
  const files = {
    0: sample,
    length: 1,
    item: (index: number) => (index === 0 ? sample : null)
  } as unknown as FileList;
  fireEvent.change(fileInput as HTMLInputElement, { target: { files } });
  await waitFor(() => expect(importButton).toBeEnabled());

  const rowCheckbox = screen.getAllByRole("checkbox")[0];
  fireEvent.click(rowCheckbox);

  expect(importButton).toBeDisabled();
  expect(screen.getByText("0 of 1 datasets selected")).toBeInTheDocument();
});

test("groups sidecar components under one stem selection", async () => {
  const queryClient = new QueryClient();
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );

  const importButton = screen.getByRole("button", { name: "Import & Continue" });
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
  expect(fileInput).not.toBeNull();

  const shp = new File(["shape"], "JRShinjukuSta_B1_Space.shp", { type: "application/octet-stream" });
  const shx = new File(["shape"], "JRShinjukuSta_B1_Space.shx", { type: "application/octet-stream" });
  const files = {
    0: shp,
    1: shx,
    length: 2,
    item: (index: number) => (index === 0 ? shp : index === 1 ? shx : null)
  } as unknown as FileList;
  fireEvent.change(fileInput as HTMLInputElement, { target: { files } });

  await waitFor(() => expect(importButton).toBeEnabled());
  expect(screen.getByText("1 of 1 datasets selected")).toBeInTheDocument();
  expect(screen.getByText("JRShinjukuSta_B1_Space")).toBeInTheDocument();
  expect(screen.getByText(".shp, .shx")).toBeInTheDocument();
});

test("queues geopackage uploads as selectable sources", async () => {
  const queryClient = new QueryClient();
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );

  const importButton = screen.getByRole("button", { name: "Import & Continue" });
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
  expect(fileInput).not.toBeNull();

  const gpkg = new File(["gpkg"], "station.gpkg", { type: "application/octet-stream" });
  const files = {
    0: gpkg,
    length: 1,
    item: (index: number) => (index === 0 ? gpkg : null)
  } as unknown as FileList;
  fireEvent.change(fileInput as HTMLInputElement, { target: { files } });

  await waitFor(() => expect(importButton).toBeEnabled());
  expect(screen.getByText("1 of 1 datasets selected")).toBeInTheDocument();
  expect(screen.getByText("station.gpkg")).toBeInTheDocument();
  expect(screen.getByText(".gpkg")).toBeInTheDocument();
});


test("shows prefer-filename-floor checkbox only in IMDF-schema mode and passes it to the API", async () => {
  const importImdf = vi.mocked(importImdfShapefiles);
  importImdf.mockResolvedValue({
    session_id: "session-1",
    import_profile: "imdf_shapefile",
    files: [],
    cleanup_summary: {
      multipolygons_exploded: 0,
      rings_closed: 0,
      features_reoriented: 0,
      empty_features_dropped: 0,
      coordinates_rounded: 0
    },
    warnings: []
  });

  const queryClient = new QueryClient();
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );

  const checkboxLabel = "Prefer the floor in the filename when it disagrees with the source level";
  expect(screen.queryByLabelText(checkboxLabel)).not.toBeInTheDocument();

  fireEvent.click(screen.getByText("IMDF-schema shapefiles"));
  const checkbox = screen.getByLabelText(checkboxLabel);
  expect(checkbox).toBeInTheDocument();

  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
  expect(fileInput).not.toBeNull();
  const sample = new File(["shape"], "sample.shp", { type: "application/octet-stream" });
  const files = {
    0: sample,
    length: 1,
    item: (index: number) => (index === 0 ? sample : null)
  } as unknown as FileList;
  fireEvent.change(fileInput as HTMLInputElement, { target: { files } });

  await waitFor(() => expect(screen.getByRole("button", { name: "Import to Review" })).toBeEnabled());
  fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("button", { name: "Import to Review" }));

  await waitFor(() => expect(importImdf).toHaveBeenCalled());
  expect(importImdf.mock.calls[0][2]).toBe(true);
});
