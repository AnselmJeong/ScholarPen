import React, { useEffect, useState } from "react";
import {
  FileCode2,
  FileText,
  Globe2,
  Loader2,
  Play,
} from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Text } from "@astryxdesign/core/Text";
import { AppDialog } from "@/components/ui/app-dialog";
import type { QuartoRenderFormat, QuartoRenderResult } from "@shared/rpc-types";

interface QuartoRenderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  formats: QuartoRenderFormat[];
  loading: boolean;
  loadError: string | null;
  onRender: (format: QuartoRenderFormat) => Promise<QuartoRenderResult>;
}

const FORMAT_DETAILS: Record<string, { title: string; subtitle: string; icon: typeof FileText }> = {
  docx: {
    title: "Word",
    subtitle: "Microsoft Word (.docx)",
    icon: FileText,
  },
  html: {
    title: "HTML",
    subtitle: "Browser-ready book",
    icon: Globe2,
  },
  typst: {
    title: "PDF",
    subtitle: "PDF generated with Typst",
    icon: FileCode2,
  },
  pdf: {
    title: "PDF (LaTeX)",
    subtitle: "PDF generated with LaTeX",
    icon: FileCode2,
  },
};

function getFormatDetails(format: string) {
  return Object.hasOwn(FORMAT_DETAILS, format) ? FORMAT_DETAILS[format]! : {
    title: format,
    subtitle: "Custom Quarto format",
    icon: FileCode2,
  };
}

export function QuartoRenderDialog({
  open,
  onOpenChange,
  formats,
  loading,
  loadError,
  onRender,
}: QuartoRenderDialogProps) {
  const [selectedFormat, setSelectedFormat] = useState<QuartoRenderFormat | null>(null);
  const [rendering, setRendering] = useState(false);
  const [result, setResult] = useState<QuartoRenderResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || loading) return;
    setSelectedFormat((current) => current && formats.includes(current) ? current : formats[0] ?? null);
    setResult(null);
    setRequestError(null);
  }, [formats, loading, open]);

  const handleRender = async () => {
    if (!selectedFormat || rendering) return;
    setRendering(true);
    setResult(null);
    setRequestError(null);
    try {
      setResult(await onRender(selectedFormat));
    } catch (error) {
      setRequestError(
        error instanceof Error
          ? error.message
          : "ScholarPen could not start the Quarto render request.",
      );
    } finally {
      setRendering(false);
    }
  };

  const visibleError = loadError ?? requestError;
  const logText = result
    ? [result.stderr, result.stdout].filter(Boolean).join("\n\n")
    : "";

  return (
    <AppDialog
      isOpen={open}
      onOpenChange={(nextOpen) => { if (!rendering) onOpenChange(nextOpen); }}
      purpose={rendering ? "required" : "info"}
      width={520}
      title="Render Quarto Book"
      subtitle={<>Choose one format configured in <span className="font-mono-ui">exports/_quarto.yml</span>.</>}
      footer={<>
        <Button label="Close" variant="secondary" isDisabled={rendering} onClick={() => onOpenChange(false)} />
        <Button label={rendering ? "Rendering…" : "Render"} variant="primary" isLoading={rendering}
          isDisabled={!selectedFormat || loading || Boolean(visibleError) || rendering} onClick={handleRender}
          icon={<Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />} />
      </>}
    >
      {loading ? (
        <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Reading configured formats…
        </div>
      ) : formats.length > 0 ? (
        <RadioList label="Output format" value={selectedFormat ?? ""} isDisabled={rendering}
          onChange={(value) => setSelectedFormat(value as QuartoRenderFormat)}>
          {formats.map((format) => {
            const details = getFormatDetails(format);
            const Icon = details.icon;
            return (
              <RadioListItem key={format} value={format} label={details.title} description={details.subtitle}
                startContent={<Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
                endContent={<Text type="code" size="xsm" color="secondary">{format}</Text>} />
            );
          })}
        </RadioList>
      ) : !visibleError ? (
        <Banner status="warning" title="No output format is configured."
          description="Open the Quarto editor and select an output format." />
      ) : null}

      {rendering && (
        <Banner status="info" title={`Rendering ${selectedFormat ? getFormatDetails(selectedFormat).title : "book"}…`}
          description="Quarto is processing every configured chapter. Keep this dialog open." />
      )}

      {visibleError && (
        <div role="alert">
          <Banner status="error" title="Could not prepare rendering" description={<span className="whitespace-pre-wrap">{visibleError}</span>} />
        </div>
      )}

      {result?.status === "success" && (
        <Banner status="success" title="Render complete"
          description={<><span className="break-all">Output: {result.outputDirectory}</span><br />Completed in {(result.durationMs / 1000).toFixed(1)} seconds.</>} />
      )}

      {result?.status === "error" && (
        <div role="alert">
          <Banner status="error" title="Render failed"
            description={<><span className="whitespace-pre-wrap">{result.message}</span>{result.exitCode !== null && <><br />Exit code: {result.exitCode}</>}</>} />
        </div>
      )}

      {logText && (
        <details open={result?.status === "error"} className="overflow-hidden rounded-md border border-border">
          <summary className="cursor-pointer bg-muted/45 px-3 py-2 text-xs font-medium">
            Quarto log
          </summary>
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono-ui text-[10px] leading-relaxed text-muted-foreground">
            {logText}
          </pre>
        </details>
      )}
    </AppDialog>
  );
}
