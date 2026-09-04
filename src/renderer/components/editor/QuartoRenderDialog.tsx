import React, { useEffect, useState } from "react";
import {
  CircleAlert,
  CircleCheck,
  FileCode2,
  FileText,
  Globe2,
  Loader2,
  Play,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { QuartoRenderFormat, QuartoRenderResult } from "@shared/rpc-types";

interface QuartoRenderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  formats: QuartoRenderFormat[];
  loading: boolean;
  loadError: string | null;
  onRender: (format: QuartoRenderFormat) => Promise<QuartoRenderResult>;
}

const FORMAT_DETAILS = {
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
} as const satisfies Record<QuartoRenderFormat, {
  title: string;
  subtitle: string;
  icon: typeof FileText;
}>;

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
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!rendering) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-lg overflow-hidden p-0">
        <div className="border-b border-border bg-muted/35 px-6 pb-5 pt-6">
          <DialogHeader>
            <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Play className="h-[17px] w-[17px] fill-current" />
            </div>
            <DialogTitle>Render Quarto Book</DialogTitle>
            <DialogDescription>
              Choose one format configured in <span className="font-mono text-xs">exports/_quarto.yml</span>.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="max-h-[62vh] space-y-4 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading configured formats…
            </div>
          ) : formats.length > 0 ? (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">Output format</legend>
              {formats.map((format) => {
                const details = FORMAT_DETAILS[format];
                const Icon = details.icon;
                const selected = selectedFormat === format;
                return (
                  <label
                    key={format}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors ${selected ? "border-primary/50 bg-primary/[0.06]" : "border-border hover:bg-muted/40"}`}
                  >
                    <input
                      type="radio"
                      name="quarto-render-format"
                      value={format}
                      checked={selected}
                      onChange={() => setSelectedFormat(format)}
                      disabled={rendering}
                      className="h-3.5 w-3.5 accent-primary"
                    />
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-primary">
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{details.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{details.subtitle}</p>
                    </div>
                    <code className="text-[10px] text-muted-foreground">{format}</code>
                  </label>
                );
              })}
            </fieldset>
          ) : !visibleError ? (
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              No supported output format is configured. Open the Quarto editor and select Word, HTML, or PDF.
            </p>
          ) : null}

          {rendering && (
            <div className="rounded-xl border border-primary/25 bg-primary/[0.04] px-3.5 py-3">
              <div className="flex items-center gap-2 text-sm font-medium text-primary">
                <Loader2 className="h-4 w-4 animate-spin" />
                Rendering {selectedFormat ? FORMAT_DETAILS[selectedFormat].title : "book"}…
              </div>
              <p className="mt-1 pl-6 text-xs text-muted-foreground">
                Quarto is processing every configured chapter. Keep this dialog open.
              </p>
            </div>
          )}

          {visibleError && (
            <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 py-3 text-destructive">
              <div className="flex items-start gap-2">
                <CircleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold">Could not prepare rendering</p>
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed">{visibleError}</p>
                </div>
              </div>
            </div>
          )}

          {result?.status === "success" && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-3 text-emerald-700 dark:text-emerald-400">
              <div className="flex items-start gap-2">
                <CircleCheck className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Render complete</p>
                  <p className="mt-1 break-all text-xs">Output: {result.outputDirectory}</p>
                  <p className="mt-1 text-[11px] opacity-80">Completed in {(result.durationMs / 1000).toFixed(1)} seconds.</p>
                </div>
              </div>
            </div>
          )}

          {result?.status === "error" && (
            <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 py-3 text-destructive">
              <div className="flex items-start gap-2">
                <CircleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Render failed</p>
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed">{result.message}</p>
                  {result.exitCode !== null && (
                    <p className="mt-1 text-[11px] opacity-80">Exit code: {result.exitCode}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {logText && (
            <details open={result?.status === "error"} className="overflow-hidden rounded-xl border border-border">
              <summary className="cursor-pointer bg-muted/45 px-3.5 py-2.5 text-xs font-medium">
                Quarto log
              </summary>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words px-3.5 py-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
                {logText}
              </pre>
            </details>
          )}
        </div>

        <DialogFooter className="border-t border-border bg-muted/20 px-6 py-4">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={rendering}>
            Close
          </Button>
          <Button
            size="sm"
            onClick={handleRender}
            disabled={!selectedFormat || loading || Boolean(visibleError) || rendering}
          >
            {rendering ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Rendering…</>
            ) : (
              <><Play className="h-3.5 w-3.5 fill-current" /> Render</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
