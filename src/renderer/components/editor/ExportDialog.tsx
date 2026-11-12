import React, { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { AppDialog } from "@/components/ui/app-dialog";
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
    <AppDialog isOpen={open} onOpenChange={(next) => { if (!exporting) onOpenChange(next); }}
      title={isBulkExport ? "Export Selected Sections" : "Export Document"} width={460} purpose={exporting ? "required" : "info"}
      subtitle={destination ? `저장 위치: ${destination}` : undefined}
      footer={<>
        <Button label="Cancel" variant="secondary" isDisabled={exporting} onClick={() => onOpenChange(false)} />
        <Button variant="primary" isLoading={exporting} onClick={handleExport}
          label={exporting
            ? `Exporting ${progress?.current ?? 0}/${documentCount}\u2026`
            : isBulkExport
              ? `Export ${documentCount} files`
              : "Export"} />
      </>}>
      <Text type="body" display="block" as="p">
        {isBulkExport ? (
          <>
            Export <Text type="inherit" weight="semibold">{documentCount} selected sections</Text> as separate files:
          </>
        ) : (
          <>
            Export <Text type="inherit" weight="semibold">{documentNames[0] || "document"}</Text> as:
          </>
        )}
      </Text>

      {isBulkExport && (
        <ul className="max-h-28 overflow-y-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono-ui text-xs">
          {documentNames.map((name) => <li key={name} className="truncate py-0.5">{name}</li>)}
        </ul>
      )}

      <RadioList label="Format" isLabelHidden value={format} onChange={(value) => setFormat(value as ExportFormat)} isDisabled={exporting}>
        <RadioListItem value="qmd" label="Quarto (.qmd)"
          description="YAML frontmatter, fenced divs, cross-references. Best for academic publishing." />
        <RadioListItem value="md" label="Markdown (.md)"
          description="Standard Markdown. Abstracts use blockquote fallback, no cross-references." />
      </RadioList>

      {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
      {exporting && progress && <div role="status" className="space-y-2">
        <Text type="supporting" display="block" hasTabularNumbers>{progress.current}/{progress.total} · {progress.filename}</Text>
        <Text type="supporting" display="block">{progress.stage === "reading" ? "Reading manuscript" : progress.stage === "converting" ? "Converting manuscript" : "Saving manuscript and copying figures"} · {elapsed}s</Text>
        <progress className="h-1.5 w-full accent-primary" value={progress.current - 1} max={progress.total} />
        {elapsed >= 15 && <Text type="supporting" display="block">Cloud folders may need time to download or sync figures. Make the project available offline in Google Drive if this step keeps waiting.</Text>}
      </div>}
    </AppDialog>
  );
}
