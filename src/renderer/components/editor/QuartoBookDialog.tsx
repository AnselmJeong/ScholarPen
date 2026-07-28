import React, { useRef, useState } from "react";
import { BookMarked, FileCode2, Plus, Upload, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface QuartoBookSetup {
  title: string;
  authors: string[];
  cslFile: File;
}

interface QuartoBookDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  qmdFilenames: string[];
  onGenerate: (setup: QuartoBookSetup) => Promise<void>;
}

export function QuartoBookDialog({
  open,
  onOpenChange,
  qmdFilenames,
  onGenerate,
}: QuartoBookDialogProps) {
  const [title, setTitle] = useState("");
  const [authors, setAuthors] = useState([""]);
  const [cslFile, setCslFile] = useState<File | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const normalizedAuthors = authors.map((author) => author.trim()).filter(Boolean);
  const canGenerate = Boolean(
    title.trim()
    && normalizedAuthors.length > 0
    && cslFile
    && qmdFilenames.length > 0,
  );

  const updateAuthor = (index: number, value: string) => {
    setAuthors((current) =>
      current.map((author, authorIndex) => authorIndex === index ? value : author)
    );
  };

  const removeAuthor = (index: number) => {
    setAuthors((current) =>
      current.length === 1
        ? [""]
        : current.filter((_, authorIndex) => authorIndex !== index)
    );
  };

  const handleGenerate = async () => {
    if (!cslFile || !canGenerate || generating) return;
    setGenerating(true);
    setError(null);
    try {
      await onGenerate({
        title: title.trim(),
        authors: normalizedAuthors,
        cslFile,
      });
      onOpenChange(false);
    } catch (generationError) {
      setError(
        generationError instanceof Error
          ? generationError.message
          : "Could not generate the Quarto book configuration.",
      );
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg overflow-hidden p-0">
        <div className="border-b border-border bg-muted/35 px-6 pb-5 pt-6">
          <DialogHeader>
            <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <BookMarked className="h-[18px] w-[18px]" />
            </div>
            <DialogTitle>Configure Quarto Book</DialogTitle>
            <DialogDescription>
              Generate a portable <span className="font-mono text-xs">exports/_quarto.yml</span> for all exported QMD chapters.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="max-h-[62vh] space-y-5 overflow-y-auto px-6 py-5">
          <div className="space-y-2">
            <Label htmlFor="quarto-book-title">Book title</Label>
            <Input
              id="quarto-book-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Enter the rendered book title"
              autoFocus
            />
          </div>

          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <Label>Authors</Label>
              <button
                type="button"
                onClick={() => setAuthors((current) => [...current, ""])}
                className="flex items-center gap-1 text-xs font-medium text-primary transition-opacity hover:opacity-70"
              >
                <Plus className="h-3.5 w-3.5" />
                Add author
              </button>
            </div>
            <div className="space-y-2">
              {authors.map((author, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    value={author}
                    onChange={(event) => updateAuthor(index, event.target.value)}
                    placeholder={`Author ${index + 1}`}
                    aria-label={`Author ${index + 1}`}
                  />
                  <button
                    type="button"
                    onClick={() => removeAuthor(index)}
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`Remove author ${index + 1}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Citation style</Label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csl,application/xml,text/xml"
              className="hidden"
              onChange={(event) => {
                const selected = event.target.files?.[0] ?? null;
                setCslFile(selected);
                setError(null);
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full items-center gap-3 rounded-xl border border-dashed border-border px-3.5 py-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/[0.03]"
            >
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Upload className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {cslFile?.name ?? "Choose a CSL file"}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  A copy will be stored beside the generated YAML.
                </p>
              </div>
            </button>
          </div>

          <div className="overflow-hidden rounded-xl border border-border">
            <div className="flex items-center justify-between bg-muted/45 px-3.5 py-2.5">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <FileCode2 className="h-3.5 w-3.5 text-primary" />
                Chapters
              </div>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {qmdFilenames.length} QMD {qmdFilenames.length === 1 ? "file" : "files"}
              </span>
            </div>
            {qmdFilenames.length > 0 ? (
              <div className="max-h-28 overflow-y-auto px-3.5 py-2">
                {qmdFilenames.map((filename, index) => (
                  <div key={filename} className="flex items-center gap-2 py-1 text-xs">
                    <span className="w-4 flex-shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                      {index + 1}
                    </span>
                    <span className="truncate">{filename}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="px-3.5 py-3 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
                Export at least one document as QMD before creating the book configuration.
              </p>
            )}
          </div>

          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="border-t border-border bg-muted/20 px-6 py-4">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={generating}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleGenerate} disabled={!canGenerate || generating}>
            {generating ? "Generating…" : "Generate _quarto.yml"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
