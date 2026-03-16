import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import App from "./App";


test("renders upload page heading", () => {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );

  expect(screen.getByText("SHP/GPKG to IMDF Converter")).toBeInTheDocument();
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

  const importButton = screen.getByRole("button", { name: "Import Files" });
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
  expect(screen.getByText("0 of 1 shapefile group(s) selected")).toBeInTheDocument();
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

  const importButton = screen.getByRole("button", { name: "Import Files" });
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
  expect(screen.getByText("1 of 1 shapefile group(s) selected")).toBeInTheDocument();
  expect(screen.getByText("2 of 2 component file(s) selected")).toBeInTheDocument();
  expect(screen.getByText("JRShinjukuSta_B1_Space")).toBeInTheDocument();
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

  const importButton = screen.getByRole("button", { name: "Import Files" });
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
  expect(screen.getByText("1 of 1 GeoPackage(s) selected")).toBeInTheDocument();
  expect(screen.getByText("station.gpkg")).toBeInTheDocument();
});
