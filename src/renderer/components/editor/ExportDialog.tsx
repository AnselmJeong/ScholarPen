import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { ExportFormat } from "../../blocks/markdown-serializer";

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onExport: (format: ExportFormat) => Promise<void>;
  documentName: string;
}

export function ExportDialog({ open, onOpenChange, onExport, documentName }: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>("qmd");
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      await onExport(format);
      onOpenChange(false);
    } catch (err) {
      console.error("Export failed:", err);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Export Document</DialogTitle>
        </DialogHeader>

        <div className="py-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Export <span className="font-medium text-foreground">{documentName || "document"}</span> as:
          </p>

          <div className="space-y-2">
            <label className="flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors hover:bg-accent/50 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
              <input
                type="radio"
                name="export-format"
                value="qmd"
                checked={format === "qmd"}
                onChange={() => setFormat("qmd")}
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
                onChange={() => setFormat("md")}
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

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={exporting}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleExport} disabled={exporting}>
            {exporting ? "Exporting\u2026" : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}