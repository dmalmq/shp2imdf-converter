import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { previewIllustrator } from "../api/client";
import type * as ApiClient from "../api/client";
import { buildApiClientError } from "../api/errors";
import { IllustratorPage } from "./IllustratorPage";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  previewIllustrator: vi.fn()
}));

const preview = vi.mocked(previewIllustrator);

/** Drives the real upload input the page renders, rather than calling internals. */
function uploadAnAiFile() {
  render(<IllustratorPage />);
  const input = document.getElementById("illustrator-georef-input") as HTMLInputElement;
  const file = new File([new Uint8Array([37, 80, 68, 70])], "station.ai");
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  preview.mockReset();
});

describe("IllustratorPage upload failures", () => {
  it("blames the server, not the file, when the API cannot be reached", async () => {
    // A dev proxy answers a refused connection with a bodiless 500. Before this
    // was distinguished, a stopped backend told the user to re-save a file that
    // was never the problem.
    preview.mockRejectedValue(buildApiClientError(500, ""));

    uploadAnAiFile();

    await waitFor(() => expect(screen.getByText(/could not reach the converter/i)).toBeInTheDocument());
    expect(screen.queryByText(/Create PDF Compatible File/i)).toBeNull();
  });

  it("shows the API's own explanation when the file really is unreadable", async () => {
    // The backend raises this as a 422; the page used to discard it and print a
    // hardcoded near-duplicate instead.
    preview.mockRejectedValue(
      buildApiClientError(
        422,
        JSON.stringify({
          detail: "Not a PDF-based Illustrator file. Re-save the .ai with 'Create PDF Compatible File' enabled.",
          code: "ILLUSTRATOR_CONVERSION_FAILED"
        })
      )
    );

    uploadAnAiFile();

    await waitFor(() =>
      expect(screen.getByText(/Not a PDF-based Illustrator file/i)).toBeInTheDocument()
    );
    expect(screen.queryByText(/could not reach the converter/i)).toBeNull();
  });

  it("still explains itself when the failure carries no message at all", async () => {
    preview.mockRejectedValue({});

    uploadAnAiFile();

    await waitFor(() => expect(screen.getByText(/Create PDF Compatible File/i)).toBeInTheDocument());
  });
});
