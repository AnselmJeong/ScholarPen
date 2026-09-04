import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BookMarked,
  FileText,
  FileCode2,
  Globe2,
  Loader2,
  Plus,
  Upload,
  X,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseQuartoBookConfig } from "@shared/quarto-config";
import type { QuartoBookFormat } from "@shared/quarto-config";

export interface QuartoBookSetup {
  title: string;
  authors: string[];
  cslFilename: string;
  cslFile: File | null;
  qmdFilenames: string[];
  language: string;
  outputDir: string;
  bibliographyFiles: string[];
  formats: QuartoBookFormat[];
  existingYaml: string | null;
}

interface QuartoBookDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  qmdFilenames: string[];
  initialYaml: string | null;
  loading: boolean;
  loadError: string | null;
  onGenerate: (setup: QuartoBookSetup) => Promise<void>;
}

function moveItem(items: string[], index: number, direction: -1 | 1): string[] {
  const destination = index + direction;
  if (destination < 0 || destination >= items.length) return items;
  const next = [...items];
  [next[index], next[destination]] = [next[destination]!, next[index]!];
  return next;
}

const FORMAT_ORDER = ["docx", "html", "pdf"] as const satisfies readonly QuartoBookFormat[];

export function QuartoBookDialog({
  open,
  onOpenChange,
  qmdFilenames,
  initialYaml,
  loading,
  loadError,
  onGenerate,
}: QuartoBookDialogProps) {
  const [title, setTitle] = useState("");
  const [authors, setAuthors] = useState([""]);
  const [cslFilename, setCslFilename] = useState("");
  const [cslFile, setCslFile] = useState<File | null>(null);
  const [selectedChapters, setSelectedChapters] = useState<string[]>([]);
  const [language, setLanguage] = useState("ko");
  const [outputDir, setOutputDir] = useState("_book");
  const [bibliographyFiles, setBibliographyFiles] = useState(["references.bib"]);
  const [formats, setFormats] = useState<QuartoBookFormat[]>(["docx"]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || loading) return;
    try {
      const values = parseQuartoBookConfig(initialYaml, qmdFilenames);
      setTitle(values.title);
      setAuthors(values.authors);
      setCslFilename(values.cslFilename);
      setCslFile(null);
      setSelectedChapters(values.qmdFilenames);
      setLanguage(values.language);
      setOutputDir(values.outputDir);
      setBibliographyFiles(values.bibliographyFiles);
      setFormats(values.formats);
      setError(null);
      setInitializationError(null);
    } catch (parseError) {
      setInitializationError(
        parseError instanceof Error
          ? parseError.message
          : "Could not read the existing _quarto.yml.",
      );
    }
  }, [initialYaml, loading, open, qmdFilenames]);

  const normalizedAuthors = authors.map((author) => author.trim()).filter(Boolean);
  const normalizedBibliographies = bibliographyFiles
    .map((filename) => filename.trim())
    .filter(Boolean);
  const availableChapterSet = useMemo(() => new Set(qmdFilenames), [qmdFilenames]);
  const selectedChapterSet = useMemo(() => new Set(selectedChapters), [selectedChapters]);
  const unselectedChapters = qmdFilenames.filter((filename) => !selectedChapterSet.has(filename));
  const canGenerate = Boolean(
    !loading
    && !loadError
    && !initializationError
    && title.trim()
    && normalizedAuthors.length > 0
    && cslFilename.trim()
    && selectedChapters.length > 0
    && language.trim()
    && outputDir.trim()
    && normalizedBibliographies.length > 0
    && formats.length > 0,
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

  const updateBibliography = (index: number, value: string) => {
    setBibliographyFiles((current) =>
      current.map((filename, fileIndex) => fileIndex === index ? value : filename)
    );
  };

  const removeBibliography = (index: number) => {
    setBibliographyFiles((current) =>
      current.length === 1
        ? [""]
        : current.filter((_, fileIndex) => fileIndex !== index)
    );
  };

  const toggleFormat = (format: QuartoBookFormat) => {
    setFormats((current) => {
      const selected = new Set(current);
      if (selected.has(format)) selected.delete(format);
      else selected.add(format);
      return FORMAT_ORDER.filter((candidate) => selected.has(candidate));
    });
  };

  const handleGenerate = async () => {
    if (!canGenerate || generating) return;
    setGenerating(true);
    setError(null);
    try {
      await onGenerate({
        title: title.trim(),
        authors: normalizedAuthors,
        cslFilename: cslFilename.trim(),
        cslFile,
        qmdFilenames: selectedChapters,
        language: language.trim(),
        outputDir: outputDir.trim(),
        bibliographyFiles: normalizedBibliographies,
        formats,
        existingYaml: initialYaml,
      });
      onOpenChange(false);
    } catch (generationError) {
      setError(
        generationError instanceof Error
          ? generationError.message
          : "Could not save the Quarto book configuration.",
      );
    } finally {
      setGenerating(false);
    }
  };

  const visibleError = loadError ?? initializationError ?? error;
  const editingExistingConfig = Boolean(initialYaml?.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl overflow-hidden p-0">
        <div className="border-b border-border bg-muted/35 px-6 pb-5 pt-6">
          <DialogHeader>
            <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <BookMarked className="h-[18px] w-[18px]" />
            </div>
            <DialogTitle>Configure Quarto Book</DialogTitle>
            <DialogDescription>
              {editingExistingConfig ? "Edit" : "Create"} <span className="font-mono text-xs">exports/_quarto.yml</span>. Settings not shown here are preserved.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="max-h-[68vh] space-y-5 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading the current _quarto.yml…
            </div>
          ) : (
            <>
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

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="quarto-book-language">Language</Label>
                  <Input
                    id="quarto-book-language"
                    value={language}
                    onChange={(event) => setLanguage(event.target.value)}
                    placeholder="ko"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="quarto-output-dir">Output directory</Label>
                  <Input
                    id="quarto-output-dir"
                    value={outputDir}
                    onChange={(event) => setOutputDir(event.target.value)}
                    placeholder="_book"
                  />
                </div>
              </div>

              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-3">
                  <Label>Output formats</Label>
                  <span className="text-[11px] text-muted-foreground">Select one or more</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <label className={`cursor-pointer rounded-xl border px-3 py-3 transition-colors ${formats.includes("docx") ? "border-primary/50 bg-primary/[0.06]" : "border-border hover:bg-muted/40"}`}>
                    <div className="flex items-start gap-2.5">
                      <input
                        type="checkbox"
                        checked={formats.includes("docx")}
                        onChange={() => toggleFormat("docx")}
                        className="mt-0.5 h-3.5 w-3.5 accent-primary"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-xs font-semibold">
                          <FileText className="h-3.5 w-3.5 text-primary" />
                          Word
                        </div>
                        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">DOCX for editing and review</p>
                      </div>
                    </div>
                  </label>
                  <label className={`cursor-pointer rounded-xl border px-3 py-3 transition-colors ${formats.includes("html") ? "border-primary/50 bg-primary/[0.06]" : "border-border hover:bg-muted/40"}`}>
                    <div className="flex items-start gap-2.5">
                      <input
                        type="checkbox"
                        checked={formats.includes("html")}
                        onChange={() => toggleFormat("html")}
                        className="mt-0.5 h-3.5 w-3.5 accent-primary"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-xs font-semibold">
                          <Globe2 className="h-3.5 w-3.5 text-primary" />
                          HTML
                        </div>
                        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">Interactive browser book</p>
                      </div>
                    </div>
                  </label>
                  <label className={`cursor-pointer rounded-xl border px-3 py-3 transition-colors ${formats.includes("pdf") ? "border-primary/50 bg-primary/[0.06]" : "border-border hover:bg-muted/40"}`}>
                    <div className="flex items-start gap-2.5">
                      <input
                        type="checkbox"
                        checked={formats.includes("pdf")}
                        onChange={() => toggleFormat("pdf")}
                        className="mt-0.5 h-3.5 w-3.5 accent-primary"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-xs font-semibold">
                          <FileCode2 className="h-3.5 w-3.5 text-primary" />
                          PDF
                        </div>
                        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">Fast PDF via Typst</p>
                      </div>
                    </div>
                  </label>
                </div>
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  PDF is stored as <span className="font-mono">typst</span> in YAML. Existing options for selected formats are preserved.
                </p>
              </div>

              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <Label>Bibliography</Label>
                  <button
                    type="button"
                    onClick={() => setBibliographyFiles((current) => [...current, ""])}
                    className="flex items-center gap-1 text-xs font-medium text-primary transition-opacity hover:opacity-70"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add bibliography
                  </button>
                </div>
                <div className="space-y-2">
                  {bibliographyFiles.map((filename, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Input
                        value={filename}
                        onChange={(event) => updateBibliography(index, event.target.value)}
                        placeholder="references.bib"
                        aria-label={`Bibliography ${index + 1}`}
                      />
                      <button
                        type="button"
                        onClick={() => removeBibliography(index)}
                        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        aria-label={`Remove bibliography ${index + 1}`}
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
                    if (selected) setCslFilename(selected.name);
                    setError(null);
                  }}
                />
                <div className="flex items-stretch gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-dashed border-border px-3.5 py-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/[0.03]"
                  >
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <Upload className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {cslFilename || "Choose a CSL file"}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {cslFile
                          ? "This file will be copied beside the YAML."
                          : cslFilename
                            ? "Referenced by the current _quarto.yml. Choose a file to replace it."
                            : "A copy will be stored beside the generated YAML."}
                      </p>
                    </div>
                  </button>
                  {cslFilename && (
                    <button
                      type="button"
                      onClick={() => {
                        setCslFilename("");
                        setCslFile(null);
                        if (fileInputRef.current) fileInputRef.current.value = "";
                      }}
                      className="flex w-9 flex-shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      aria-label="Clear citation style"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-border">
                <div className="flex items-center justify-between gap-3 bg-muted/45 px-3.5 py-2.5">
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    <FileCode2 className="h-3.5 w-3.5 text-primary" />
                    Chapters
                    <span className="font-normal text-muted-foreground">
                      {selectedChapters.length} selected
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setSelectedChapters((current) => [
                        ...current,
                        ...qmdFilenames.filter((filename) => !current.includes(filename)),
                      ])}
                      className="text-primary hover:underline"
                      disabled={unselectedChapters.length === 0}
                    >
                      Select all
                    </button>
                    <span className="text-border">|</span>
                    <button
                      type="button"
                      onClick={() => setSelectedChapters([])}
                      className="text-muted-foreground hover:text-foreground hover:underline"
                      disabled={selectedChapters.length === 0}
                    >
                      Clear
                    </button>
                  </div>
                </div>
                {qmdFilenames.length > 0 || selectedChapters.length > 0 ? (
                  <div className="max-h-56 overflow-y-auto px-2 py-1.5">
                    {selectedChapters.map((filename, index) => {
                      const available = availableChapterSet.has(filename);
                      return (
                        <div key={filename} className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50">
                          <input
                            type="checkbox"
                            checked
                            onChange={() => setSelectedChapters((current) => current.filter((item) => item !== filename))}
                            className="h-3.5 w-3.5 accent-primary"
                            aria-label={`Include ${filename}`}
                          />
                          <span className="w-5 flex-shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                            {index + 1}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-xs">{filename}</span>
                          {!available && (
                            <span className="text-[10px] text-amber-600 dark:text-amber-400">Missing</span>
                          )}
                          <div className="flex items-center">
                            <button
                              type="button"
                              onClick={() => setSelectedChapters((current) => moveItem(current, index, -1))}
                              disabled={index === 0}
                              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-25"
                              aria-label={`Move ${filename} up`}
                            >
                              <ArrowUp className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setSelectedChapters((current) => moveItem(current, index, 1))}
                              disabled={index === selectedChapters.length - 1}
                              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-25"
                              aria-label={`Move ${filename} down`}
                            >
                              <ArrowDown className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    {unselectedChapters.map((filename) => (
                      <label key={filename} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50">
                        <input
                          type="checkbox"
                          checked={false}
                          onChange={() => setSelectedChapters((current) => [...current, filename])}
                          className="h-3.5 w-3.5 accent-primary"
                        />
                        <span className="w-5 flex-shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{filename}</span>
                        <span className="text-[10px] text-muted-foreground">Not included</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="px-3.5 py-3 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
                    Export at least one document as QMD before creating the book configuration.
                  </p>
                )}
              </div>

              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Format options and other custom YAML keys remain unchanged when this file is saved.
              </p>
            </>
          )}

          {visibleError && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {visibleError}
            </p>
          )}
        </div>

        <DialogFooter className="border-t border-border bg-muted/20 px-6 py-4">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={generating}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleGenerate} disabled={!canGenerate || generating}>
            {generating ? "Saving…" : editingExistingConfig ? "Save _quarto.yml" : "Create _quarto.yml"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
