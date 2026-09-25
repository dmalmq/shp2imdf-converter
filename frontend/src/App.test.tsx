import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import App from "./App";


test("Bring in for a new project offers both import profiles", () => {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/p/new"]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );

  expect(screen.getByRole("radio", { name: /Standard/ })).toBeChecked();
  expect(screen.getByRole("radio", { name: /IMDF schema/ })).toBeInTheDocument();
});

test("groups sidecar components under one stem", async () => {
  const queryClient = new QueryClient();
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/p/new"]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );

  const importButton = screen.getAllByRole("button", { name: "Read the files" })[0];
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
  expect(fileInput).not.toBeNull();

  const shp = new File(["shape"], "JRShinjukuSta_B1_Space.shp", { type: "application/octet-stream" });
  const shx = new File(["shape"], "JRShinjukuSta_B1_Space.shx", { type: "application/octet-stream" });
  const dbf = new File(["shape"], "JRShinjukuSta_B1_Space.dbf", { type: "application/octet-stream" });
  const parts = [shp, shx, dbf];
  const files = { ...parts, length: 3, item: (index: number) => parts[index] ?? null } as unknown as FileList;
  fireEvent.change(fileInput as HTMLInputElement, { target: { files } });

  await waitFor(() => expect(importButton).toBeEnabled());
  expect(screen.getByText("JRShinjukuSta_B1_Space")).toBeInTheDocument();
  expect(screen.getByText(".dbf, .shp, .shx")).toBeInTheDocument();
});

test("queues geopackage uploads as sources", async () => {
  const queryClient = new QueryClient();
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/p/new"]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );

  const importButton = screen.getAllByRole("button", { name: "Read the files" })[0];
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
  expect(screen.getByText("station.gpkg")).toBeInTheDocument();
  expect(screen.getByText("GeoPackage")).toBeInTheDocument();
});
