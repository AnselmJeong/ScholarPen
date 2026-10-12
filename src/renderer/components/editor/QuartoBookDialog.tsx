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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_QUARTO_BOOK_OPTIONS, parseQuartoBookConfig } from "@shared/quarto-config";
import type {
  QuartoBookFormat,
  QuartoBookOptions,
  QuartoFigureNumbering,
  QuartoSectionNumbering,
} from "@shared/quarto-config";
import type { QuartoExtensionDiscovery } from "@shared/rpc-types";

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
  extensionFormats: string[];
  options: QuartoBookOptions;
  referenceDocFile: File | null;
}

interface QuartoBookDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  qmdFilenames: string[];
  initialYaml: string | null;
  extensions: QuartoExtensionDiscovery;
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

const SECTION_NUMBERING_CHOICES: Array<{
  value: QuartoSectionNumbering;
  title: string;
  preview: [string, string];
}> = [
  { value: "all", title: "Numbered", preview: ["1  Introduction", "1.1  Background"] },
  { value: "chapters", title: "Chapters only", preview: ["1  Introduction", "Background"] },
  { value: "none", title: "Unnumbered", preview: ["Introduction", "Background"] },
];

const FIGURE_NUMBERING_CHOICES: Array<{
  value: QuartoFigureNumbering;
  title: string;
  preview: string;
}> = [
  { value: "chapter", title: "By chapter", preview: "Figure 2.1 · Chapter 2" },
  { value: "continuous", title: "Continuous", preview: "Figure 3 · Section 2" },
];

/** Typst page sizes; Quarto's default is US Letter. */
const PAPER_SIZES = [
  { value: "a4", label: "A4" },
  { value: "us-letter", label: "US Letter" },
  { value: "a5", label: "A5" },
  { value: "jis-b5", label: "B5 (JIS)" },
];
const DEFAULT_PAPER_SIZE = "default";

function numberingHint(numbering: QuartoSectionNumbering): string {
  if (numbering === "all") {
    return "Section cross-references such as @sec-methods print the number: “Section 2.1”.";
  }
  const unnumbered = numbering === "none" ? "headings" : "sections below a chapter";
  return `In Word, @sec- cross-references to ${unnumbered} still print a number (“Section 1.1”) the heading doesn’t show; HTML uses the heading title instead. Keep numbering if the text refers to sections.`;
}

function ChoiceCard({
  name,
  checked,
  onSelect,
  title,
  children,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`cursor-pointer rounded-xl border px-3 py-2.5 transition-colors ${checked ? "border-primary/50 bg-primary/[0.06]" : "border-border hover:bg-muted/40"}`}>
      <div className="flex items-center gap-2">
        <input
          type="radio"
          name={name}
          checked={checked}
          onChange={onSelect}
          className="h-3.5 w-3.5 accent-primary"
        />
        <span className="text-xs font-semibold">{title}</span>
      </div>
      <div className="mt-1.5 pl-[22px] text-[10px] leading-snug text-muted-foreground">
        {children}
      </div>
    </label>
  );
}

function OptionRow({
  title,
  description,
  children,
}: {
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-xs font-medium">{title}</p>
        <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{description}</p>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

export function QuartoBookDialog({
  open,
  onOpenChange,
  qmdFilenames,
  initialYaml,
  extensions,
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
  const [options, setOptions] = useState<QuartoBookOptions>({ ...DEFAULT_QUARTO_BOOK_OPTIONS });
  const [referenceDocFile, setReferenceDocFile] = useState<File | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const referenceDocInputRef = useRef<HTMLInputElement>(null);
  const customFormats = useMemo(() => {
    let configured: string[] = [];
    try { configured = parseQuartoBookConfig(initialYaml, []).formats; } catch { /* Shown below. */ }
    return [...new Set([...extensions.formats.map((format) => format.name), ...configured])]
      .filter((format) => !(FORMAT_ORDER as readonly string[]).includes(format));
  }, [initialYaml, extensions]);

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
      setOptions(values.options);
      setReferenceDocFile(null);
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

  const updateOption = <Key extends keyof QuartoBookOptions>(
    key: Key,
    value: QuartoBookOptions[Key],
  ) => setOptions((current) => ({ ...current, [key]: value }));

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
      return [...FORMAT_ORDER, ...customFormats].filter((candidate) => selected.has(candidate));
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
        extensionFormats: customFormats,
        options: { ...options, subtitle: options.subtitle.trim() },
        referenceDocFile,
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
  const paperSizes = options.typstPaperSize
    && !PAPER_SIZES.some((size) => size.value === options.typstPaperSize)
    ? [...PAPER_SIZES, { value: options.typstPaperSize, label: options.typstPaperSize }]
    : PAPER_SIZES;

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

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="quarto-book-subtitle">Subtitle</Label>
                  <span className="text-[11px] text-muted-foreground">Optional</span>
                </div>
                <Input
                  id="quarto-book-subtitle"
                  value={options.subtitle}
                  onChange={(event) => updateOption("subtitle", event.target.value)}
                  placeholder="Shown under the title"
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
                {customFormats.length > 0 && (
                  <div className="space-y-2">
                    <Label>Additional formats</Label>
                    {customFormats.map((format) => {
                      const extension = extensions.formats.find((item) => item.name === format);
                      return (
                        <label key={format} className={`flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-3 ${formats.includes(format) ? "border-primary/50 bg-primary/[0.06]" : "border-border hover:bg-muted/40"}`}>
                          <input type="checkbox" checked={formats.includes(format)} onChange={() => toggleFormat(format)} className="mt-0.5 h-3.5 w-3.5 accent-primary" />
                          <div className="min-w-0">
                            <p className="break-all text-xs font-semibold">{format}</p>
                            <p className="mt-1 text-[10px] text-muted-foreground">{extension ? `${extension.title} · ${extension.baseFormat}` : "Configured in _quarto.yml"}</p>
                          </div>
                        </label>
                      );
                    })}
                    <p className="text-[10px] text-muted-foreground">Save selected formats to make them available in Render.</p>
                  </div>
                )}
                {extensions.warnings.length > 0 && (
                  <div role="status" className="rounded-lg bg-amber-500/10 p-3 text-xs">
                    <p>Some extensions could not be loaded:</p>
                    {extensions.warnings.map((warning, index) => <p key={index} className="mt-1 break-words">{warning}</p>)}
                  </div>
                )}
              </div>

              <div className="space-y-2.5">
                <Label>Heading numbers</Label>
                <div className="grid grid-cols-3 gap-2">
                  {SECTION_NUMBERING_CHOICES.map((choice) => (
                    <ChoiceCard
                      key={choice.value}
                      name="quarto-section-numbering"
                      checked={options.sectionNumbering === choice.value}
                      onSelect={() => updateOption("sectionNumbering", choice.value)}
                      title={choice.title}
                    >
                      <p className="font-medium text-foreground/80">{choice.preview[0]}</p>
                      <p className="pl-2">{choice.preview[1]}</p>
                    </ChoiceCard>
                  ))}
                </div>
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  {numberingHint(options.sectionNumbering)}
                  {formats.includes("pdf") && options.sectionNumbering !== "all"
                    && " PDF books always number chapters and sections."}
                </p>
              </div>

              {formats.includes("docx") && (
                <div className="space-y-3.5 rounded-xl border border-border px-3.5 py-3">
                  <div className="flex items-center gap-1.5 text-xs font-semibold">
                    <FileText className="h-3.5 w-3.5 text-primary" />
                    Word options
                  </div>
                  <OptionRow
                    title="Table of contents"
                    description="List chapters and sections at the start of the document."
                  >
                    <Switch
                      checked={options.docxToc}
                      onCheckedChange={(checked) => updateOption("docxToc", checked)}
                      aria-label="Word table of contents"
                    />
                  </OptionRow>
                  <div className="space-y-2">
                    <div>
                      <p className="text-xs font-medium">Figure and table numbers</p>
                      <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                        Continuous suits articles: it also calls top-level headings “Section” in cross-references.
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {FIGURE_NUMBERING_CHOICES.map((choice) => (
                        <ChoiceCard
                          key={choice.value}
                          name="quarto-figure-numbering"
                          checked={options.docxFigureNumbering === choice.value}
                          onSelect={() => updateOption("docxFigureNumbering", choice.value)}
                          title={choice.title}
                        >
                          {choice.preview}
                        </ChoiceCard>
                      ))}
                    </div>
                    {options.sectionNumbering === "none" && options.docxFigureNumbering === "chapter" && (
                      <p className="rounded-lg bg-amber-500/10 px-2.5 py-2 text-[10px] leading-relaxed text-amber-700 dark:text-amber-400">
                        Chapters are unnumbered, so “Figure 2.1” refers to a chapter number readers can’t see. Continuous numbering avoids this.
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <div>
                      <p className="text-xs font-medium">Template</p>
                      <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                        A .docx whose styles set fonts, heading styles, spacing and margins.
                      </p>
                    </div>
                    <input
                      ref={referenceDocInputRef}
                      type="file"
                      accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      className="hidden"
                      onChange={(event) => {
                        const selected = event.target.files?.[0] ?? null;
                        setReferenceDocFile(selected);
                        if (selected) updateOption("docxReferenceDoc", selected.name);
                        setError(null);
                      }}
                    />
                    <div className="flex items-stretch gap-2">
                      <button
                        type="button"
                        onClick={() => referenceDocInputRef.current?.click()}
                        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-dashed border-border px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-primary/[0.03]"
                      >
                        <Upload className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">
                            {options.docxReferenceDoc || "Quarto’s default styles"}
                          </span>
                          <span className="block text-[10px] text-muted-foreground">
                            {referenceDocFile
                              ? "This file will be copied beside the YAML."
                              : options.docxReferenceDoc
                                ? "Referenced by the current _quarto.yml. Choose a file to replace it."
                                : "Choose a .docx template"}
                          </span>
                        </span>
                      </button>
                      {options.docxReferenceDoc && (
                        <button
                          type="button"
                          onClick={() => {
                            updateOption("docxReferenceDoc", "");
                            setReferenceDocFile(null);
                            if (referenceDocInputRef.current) referenceDocInputRef.current.value = "";
                          }}
                          className="flex w-9 flex-shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                          aria-label="Use Quarto's default Word styles"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {formats.includes("pdf") && (
                <div className="space-y-3 rounded-xl border border-border px-3.5 py-3">
                  <div className="flex items-center gap-1.5 text-xs font-semibold">
                    <FileCode2 className="h-3.5 w-3.5 text-primary" />
                    PDF options
                  </div>
                  <OptionRow
                    title="Paper size"
                    description="Quarto’s PDF book layout always adds chapter numbers and a table of contents."
                  >
                    <Select
                      value={options.typstPaperSize || DEFAULT_PAPER_SIZE}
                      onValueChange={(value) => updateOption(
                        "typstPaperSize",
                        value === DEFAULT_PAPER_SIZE ? "" : value,
                      )}
                    >
                      <SelectTrigger className="w-40 text-xs" aria-label="PDF paper size">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT_PAPER_SIZE} className="text-xs">
                          Default (US Letter)
                        </SelectItem>
                        {paperSizes.map((size) => (
                          <SelectItem key={size.value} value={size.value} className="text-xs">
                            {size.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </OptionRow>
                </div>
              )}

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

              <OptionRow
                title="Link citations to the reference list"
                description="Clicking a citation such as [12] jumps to its entry in the bibliography."
              >
                <Switch
                  checked={options.linkCitations}
                  onCheckedChange={(checked) => updateOption("linkCitations", checked)}
                  aria-label="Link citations to the reference list"
                />
              </OptionRow>

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
