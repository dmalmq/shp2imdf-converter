import { Loader2, Upload } from "lucide-react";
import { useCallback } from "react";
import { useDropzone } from "react-dropzone";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";

type Props = {
  loading: boolean;
  error: string | null;
  onFile: (file: File) => void;
};

/**
 * Stage 1 of the Illustrator route.
 *
 * `.ai` is a file people drag, but the old screen hid a bare `<input>` behind a
 * button and never mentioned that PDFs work too, despite `accept=".ai,.pdf"`.
 */
export function ArtworkDropzone({ loading, error, onFile }: Props) {
  const { t } = useUiLanguage();

  const onDrop = useCallback(
    (accepted: File[]) => {
      const file = accepted[0];
      if (file) onFile(file);
    },
    [onFile]
  );

  const { getRootProps, getInputProps, open, isDragActive } = useDropzone({
    onDrop,
    multiple: false,
    noClick: true,
    noKeyboard: true,
    disabled: loading,
    accept: { "application/postscript": [".ai"], "application/pdf": [".pdf"] }
  });

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col items-center gap-6 px-4 py-16">
      <div className="flex flex-col items-center gap-1.5 text-center">
        <h1 className="text-2xl font-semibold leading-8 tracking-tight text-foreground">
          {t("Place Illustrator artwork", "Illustrator図面の配置")}
        </h1>
        <p className="text-sm leading-5 text-muted-foreground">
          {t(
            "Convert a drawing, position it on the map, then export georeferenced files.",
            "図面を変換し、地図上に配置してから、座標付きファイルを書き出します。"
          )}
        </p>
      </div>

      <div
        {...getRootProps()}
        className={cn(
          "flex w-full flex-col items-center justify-center gap-3 rounded-xl border-[1.5px] border-dashed",
          "border-border bg-card px-6 py-14 transition-colors",
          isDragActive && "border-signal bg-signal-muted",
          loading && "opacity-70"
        )}
      >
        {/* react-dropzone owns this input; the id is kept because the Playwright
            audit scripts and e2e specs drive the flow through it. */}
        <input {...getInputProps()} id="illustrator-georef-input" />

        {loading ? (
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" strokeWidth={1.5} />
        ) : (
          <Upload className="h-8 w-8 text-muted-foreground" strokeWidth={1.5} />
        )}

        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-[15px] font-medium leading-[22px] text-foreground">
            {loading
              ? t("Converting…", "変換中…")
              : isDragActive
                ? t("Drop to convert", "ドロップして変換")
                : t("Drop your Illustrator file here", "Illustrator ファイルをここにドロップ")}
          </p>
          <p className="text-[13px] leading-[18px] text-muted-foreground">
            {t(
              ".ai or .pdf  ·  one building, one page per floor",
              ".ai または .pdf  ·  1施設、1フロア1ページ"
            )}
          </p>
        </div>

        <Button type="button" disabled={loading} onClick={open}>
          {t("Choose file", "ファイルを選択")}
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-[13px] leading-[18px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
