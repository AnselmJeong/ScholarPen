import React, { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { ExportFormat } from "../../blocks/markdown-serializer";

export interface ExportProgress { current: number; total: number; filename: string; stage: "reading" | "converting" | "saving" }
interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onExport: (format: ExportFormat, onProgress: (progress: ExportProgress) => void) => Promise<void>;
  documentNames: string[];
  destination?: string;
}

export function ExportDialog({ open, onOpenChange, onExport, documentNames, destination }: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>("qmd");
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState("");
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!exporting) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [exporting, startedAt]);
  const documentCount = documentNames.length;
  const isBulkExport = documentCount > 1;

  const handleExport = async () => {
    setExporting(true);
    setError(""); setProgress(null); setElapsed(0); setStartedAt(Date.now());
    try {
      await onExport(format, setProgress);
      onOpenChange(false);
    } catch (err) {
      console.error("Export failed:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{isBulkExport ? "Export Selected Sections" : "Export Document"}</DialogTitle>
        </DialogHeader>

        <div className="py-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            {isBulkExport ? (
              <>
                Export <span className="font-medium text-foreground">{documentCount} selected sections</span> as separate files:
              </>
            ) : (
              <>
                Export <span className="font-medium text-foreground">{documentNames[0] || "document"}</span> as:
              </>
            )}
          </p>

          {destination && <p className="break-all text-xs text-muted-foreground">저장 위치: {destination}</p>}

          {isBulkExport && (
            <div className="max-h-28 overflow-y-auto rounded-lg border bg-muted/30 px-3 py-2">
              {documentNames.map((name) => (
                <div key={name} className="truncate py-0.5 text-xs text-foreground">
                  {name}
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <label className="flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors hover:bg-accent/50 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
              <input
                type="radio"
                name="export-format"
                value="qmd"
                checked={format === "qmd"}
                onChange={() => setFormat("qmd")} disabled={exporting}
                className="mt-0.5"
              />
              <div>
                <div className="text-sm font-medium">Quarto (.qmd)</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  YAML frontmatter, fenced divs, cross-references. Best for academic publishing.
                </div>
              </div>
            </label>

            <label className="flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors hover:bg-accent/50 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
              <input
                type="radio"
                name="export-format"
                value="md"
                checked={format === "md"}
                onChange={() => setFormat("md")} disabled={exporting}
                className="mt-0.5"
              />
              <div>
                <div className="text-sm font-medium">Markdown (.md)</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Standard Markdown. Abstracts use blockquote fallback, no cross-references.
                </div>
              </div>
            </label>
          </div>
        </div>

        {error && <p role="alert" className="text-sm text-destructive break-words">{error}</p>}
        {exporting && progress && <div role="status" className="space-y-2 text-xs text-muted-foreground">
          <p className="break-all">{progress.current}/{progress.total} · {progress.filename}</p>
          <p>{progress.stage === "reading" ? "Reading manuscript" : progress.stage === "converting" ? "Converting manuscript" : "Saving manuscript and copying figures"} · {elapsed}s</p>
          <progress className="w-full" value={progress.current - 1} max={progress.total} />
          {elapsed >= 15 && <p>Cloud folders may need time to download or sync figures. Make the project available offline in Google Drive if this step keeps waiting.</p>}
        </div>}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={exporting}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleExport} disabled={exporting}>
            {exporting
              ? `Exporting ${progress?.current ?? 0}/${documentCount}\u2026`
              : isBulkExport
                ? `Export ${documentCount} files`
                : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
