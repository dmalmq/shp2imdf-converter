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

  expect(screen.getByText("SHP to IMDF Converter")).toBeInTheDocument();
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

  const rowCheckbox = screen.getByRole("checkbox");
  fireEvent.click(rowCheckbox);

  expect(importButton).toBeDisabled();
  expect(screen.getByText("0 of 1 file(s) selected")).toBeInTheDocument();
});
