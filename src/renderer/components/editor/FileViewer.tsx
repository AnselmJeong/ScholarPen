import React, { Suspense, lazy, useState, useEffect, useMemo, useCallback, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileJson, FileText, BookOpen, Image as ImageIcon, File, ZoomIn, ZoomOut } from "lucide-react";
import { rpc } from "../../rpc";
import type { FileNode } from "../../../shared/rpc-types";
import { parseFrontmatter } from "../../utils/frontmatter";
import { FrontmatterCard } from "./FrontmatterCard";
import { BibtexEditor } from "./BibtexEditor";
import { TextFindPanel } from "./TextFindPanel";
import { useTextFind } from "../../hooks/useTextFind";

interface FileViewerProps {
  file: FileNode;
  reloadTrigger?: number;
}

const PdfViewer = lazy(() => import("./PdfViewer").then((m) => ({ default: m.PdfViewer })));


function getFileIcon(kind: FileNode["kind"]) {
  switch (kind) {
    case "document": return <FileJson className="h-5 w-5 text-primary" />;
    case "note": return <FileText className="h-5 w-5 text-blue-500" />;
    case "reference": return <BookOpen className="h-5 w-5 text-emerald-500" />;
    case "figure": return <ImageIcon className="h-5 w-5 text-purple-500" />;
    default: return <File className="h-5 w-5 text-gray-400" />;
  }
}

function getExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

const FONT_SIZES = [13, 15, 17, 19, 22] as const;
const FONT_SIZE_KEY = "fileviewer-font-size";

export function FileViewer({ file, reloadTrigger = 0 }: FileViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const find = useTextFind(contentRef, file.path);
  const [fontSizeIdx, setFontSizeIdx] = useState<number>(() => {
    const saved = localStorage.getItem(FONT_SIZE_KEY);
    return saved ? Math.min(Math.max(Number(saved), 0), FONT_SIZES.length - 1) : 1;
  });

  const fontSize = FONT_SIZES[fontSizeIdx];
  const zoomIn  = useCallback(() => setFontSizeIdx((i) => { const n = Math.min(i + 1, FONT_SIZES.length - 1); localStorage.setItem(FONT_SIZE_KEY, String(n)); return n; }), []);
  const zoomOut = useCallback(() => setFontSizeIdx((i) => { const n = Math.max(i - 1, 0);                    localStorage.setItem(FONT_SIZE_KEY, String(n)); return n; }), []);
  // Cmd+F to open find panel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Clear find state when file changes
  useEffect(() => {
    setFindOpen(false);
    find.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, reloadTrigger]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    rpc.readTextFile(file.path)
      .then((text) => {
        if (!cancelled) {
          setContent(text);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || "Failed to load file");
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [file.path, reloadTrigger]);

  const ext = getExt(file.name).toLowerCase();
  const isMarkdown = [".md", ".qmd", ".markdown"].includes(ext);
  const isBibtex = ext === ".bib";
  const isCode = [".txt", ".json", ".yaml", ".yml", ".toml", ".tex", ".cls", ".sty", ".bst"].includes(ext);

  // Parse YAML frontmatter from markdown content — must be before any early returns
  const { frontmatter: parsedFrontmatter, body: markdownBody } = useMemo(
    () => isMarkdown && content ? parseFrontmatter(content) : { frontmatter: null, body: content ?? "" },
    [content, isMarkdown]
  );

  // PDF viewer — binary file, handled separately
  if (file.kind === "pdf" || ext === ".pdf") {
    return (
      <Suspense fallback={<div className="flex-1 flex items-center justify-center bg-background text-sm text-muted-foreground">Loading PDF viewer...</div>}>
        <PdfViewer file={file} />
      </Suspense>
    );
  }

  // Image viewer — use data URL directly
  if (file.kind === "figure") {
    const isImage = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"].includes(ext);

    if (isImage) {
      // For project-local images, we can't load them via file:// in webview,
      // so we show a placeholder with the path
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-8 bg-background">
          <ImageIcon className="h-16 w-16 text-muted-foreground/30 mb-4" />
          <p className="text-sm text-muted-foreground mb-1">{file.name}</p>
          <p className="text-xs text-muted-foreground/60">{file.path}</p>
        </div>
      );
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading {file.name}...</p>
      </div>
    );
  }

  if (error || content === null) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-background">
        {getFileIcon(file.kind)}
        <p className="mt-2 text-sm text-foreground">{file.name}</p>
        <p className="text-xs text-red-400 mt-1">{error || "Could not read file"}</p>
      </div>
    );
  }

  if (isBibtex) {
    return <BibtexEditor file={file} initialContent={content} reloadTrigger={reloadTrigger} />;
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background relative">
      {findOpen && (
        <TextFindPanel
          query={find.query}
          onQueryChange={find.setQuery}
          matchCount={find.matchCount}
          currentIdx={find.currentIdx}
          onNext={find.goNext}
          onPrev={find.goPrev}
          onClose={() => { setFindOpen(false); find.clear(); }}
        />
      )}
      {/* Header */}
      <div className="px-6 py-2 border-b border-border text-sm text-muted-foreground font-medium flex items-center gap-2">
        {getFileIcon(file.kind)}
        <span>{file.name}</span>
        {isMarkdown && <span className="text-xs text-muted-foreground/60 ml-2">Markdown</span>}
        {isMarkdown && (
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={zoomOut}
              disabled={fontSizeIdx === 0}
              className="p-1 rounded hover:bg-accent disabled:opacity-30 transition-colors"
              title="글자 작게"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <span className="text-xs w-7 text-center">{fontSize}px</span>
            <button
              onClick={zoomIn}
              disabled={fontSizeIdx === FONT_SIZES.length - 1}
              className="p-1 rounded hover:bg-accent disabled:opacity-30 transition-colors"
              title="글자 크게"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Content */}
      <div ref={contentRef} className="flex-1 overflow-y-auto">
        {isMarkdown && (
          <div className="max-w-3xl mx-auto px-8 py-6">
            {parsedFrontmatter && <FrontmatterCard frontmatter={parsedFrontmatter} />}
            <div className="prose prose-gray dark:prose-invert" style={{ fontSize }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {markdownBody}
              </ReactMarkdown>
            </div>
          </div>
        )}

        {isCode && (
          <div className="max-w-4xl mx-auto px-4 py-4 bg-muted/50 border border-border rounded-lg m-4">
            <div className="overflow-x-auto">
              <pre className="text-xs font-mono whitespace-pre text-foreground">{content}</pre>
            </div>
          </div>
        )}

        {!isMarkdown && !isBibtex && !isCode && (
          <div className="max-w-4xl mx-auto px-4 py-4 bg-muted/50 border border-border rounded-lg m-4">
            <div className="overflow-x-auto">
              <pre className="text-xs font-mono whitespace-pre text-foreground">{content}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
