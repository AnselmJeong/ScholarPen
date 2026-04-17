import React, { useState, useEffect, useMemo, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileJson, FileText, BookOpen, Image as ImageIcon, File, ZoomIn, ZoomOut, FilterX } from "lucide-react";
import { rpc } from "../../rpc";
import type { FileNode } from "../../../shared/rpc-types";
import { parseFrontmatter } from "../../utils/frontmatter";
import { FrontmatterCard } from "./FrontmatterCard";
import { PdfViewer } from "./PdfViewer";
import { deduplicateBibtex, parseBibtexCitekeys } from "../../../shared/bibtex-utils";

interface FileViewerProps {
  file: FileNode;
}

// Token types for single-pass BibTeX highlighting
type TokenType = "entry" | "field" | "value" | "year" | "plain";
interface Token { type: TokenType; text: string }

/** Tokenize a single BibTeX line in one pass (no regex overlap) */
function tokenizeBibtexLine(line: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  // 1. Entry type: @word{
  const entryMatch = line.match(/^(@\w+)\{/);
  if (entryMatch) {
    tokens.push({ type: "entry", text: entryMatch[1] });
    tokens.push({ type: "plain", text: "{" });
    pos = entryMatch[0].length;
  }

  // 2. Scan the rest character-by-character for field=/value/"year"
  while (pos < line.length) {
    // Field name followed by =
    const fieldMatch = line.slice(pos).match(/^(\w+)\s*=/);
    if (fieldMatch) {
      tokens.push({ type: "field", text: fieldMatch[1] });
      tokens.push({ type: "plain", text: line.slice(pos + fieldMatch[1].length, pos + fieldMatch[0].length) });
      pos += fieldMatch[0].length;
      continue;
    }

    // Quoted string value
    const quoteMatch = line.slice(pos).match(/^("[^"]*")/);
    if (quoteMatch) {
      tokens.push({ type: "value", text: quoteMatch[1] });
      pos += quoteMatch[0].length;
      continue;
    }

    // 4-digit year (standalone, not inside quotes — those are already consumed)
    const yearMatch = line.slice(pos).match(/^(\d{4})/);
    if (yearMatch) {
      tokens.push({ type: "year", text: yearMatch[1] });
      pos += yearMatch[0].length;
      continue;
    }

    // Plain character
    const lastPlain = tokens[tokens.length - 1];
    const ch = line[pos];
    if (lastPlain?.type === "plain") {
      lastPlain.text += ch;
    } else {
      tokens.push({ type: "plain", text: ch });
    }
    pos++;
  }

  return tokens;
}

const TOKEN_CLASS: Record<TokenType, string> = {
  entry:  "text-purple-600 font-semibold",
  field:  "text-blue-600",
  value:  "text-green-700",
  year:   "text-orange-600",
  plain:  "",
};

/** Syntax-highlighted BibTeX rendering using JSX (no dangerouslySetInnerHTML) */
function highlightBibtex(code: string): React.ReactNode[] {
  const lines = code.split("\n");
  return lines.map((line, i) => {
    const tokens = tokenizeBibtexLine(line);
    return (
      <div key={i} className="flex">
        <span className="w-10 text-right pr-3 text-muted-foreground/50 select-none text-xs leading-5">{i + 1}</span>
        <span className="flex-1 text-xs leading-5 font-mono whitespace-pre">
          {tokens.map((t, j) =>
            TOKEN_CLASS[t.type] ? (
              <span key={j} className={TOKEN_CLASS[t.type]}>{t.text}</span>
            ) : (
              <span key={j}>{t.text}</span>
            )
          )}
        </span>
      </div>
    );
  });
}


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

export function FileViewer({ file }: FileViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dedupMsg, setDedupMsg] = useState<string | null>(null);
  const [fontSizeIdx, setFontSizeIdx] = useState<number>(() => {
    const saved = localStorage.getItem(FONT_SIZE_KEY);
    return saved ? Math.min(Math.max(Number(saved), 0), FONT_SIZES.length - 1) : 1;
  });

  const fontSize = FONT_SIZES[fontSizeIdx];
  const zoomIn  = useCallback(() => setFontSizeIdx((i) => { const n = Math.min(i + 1, FONT_SIZES.length - 1); localStorage.setItem(FONT_SIZE_KEY, String(n)); return n; }), []);
  const zoomOut = useCallback(() => setFontSizeIdx((i) => { const n = Math.max(i - 1, 0);                    localStorage.setItem(FONT_SIZE_KEY, String(n)); return n; }), []);

  const handleDedup = useCallback(async () => {
    if (!content) return;
    const before = parseBibtexCitekeys(content).length;
    const deduped = deduplicateBibtex(content);
    const after = parseBibtexCitekeys(deduped).length;
    const removed = before - after;
    const projectPath = file.path.substring(0, file.path.lastIndexOf("/"));
    await rpc.saveBibtex(projectPath, deduped);
    setContent(deduped);
    setDedupMsg(removed > 0 ? `${removed}개 중복 항목 제거됨` : "중복 없음");
    setTimeout(() => setDedupMsg(null), 3000);
  }, [content, file.path]);

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
  }, [file.path]);

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
    return <PdfViewer file={file} />;
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

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="px-6 py-2 border-b border-border text-sm text-muted-foreground font-medium flex items-center gap-2">
        {getFileIcon(file.kind)}
        <span>{file.name}</span>
        {isBibtex && <span className="text-xs text-muted-foreground/60 ml-2">BibTeX</span>}
        {isBibtex && (
          <div className="ml-auto flex items-center gap-2">
            {dedupMsg && <span className="text-xs text-emerald-500">{dedupMsg}</span>}
            <button
              onClick={handleDedup}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
              title="citekey/DOI 중복 항목 제거"
            >
              <FilterX className="h-3.5 w-3.5" />
              중복 제거
            </button>
          </div>
        )}
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
      <div className="flex-1 overflow-y-auto">
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

        {isBibtex && (
          <div className="max-w-4xl mx-auto px-4 py-4 bg-muted/50 border border-border rounded-lg m-4">
            <div className="overflow-x-auto">
              {highlightBibtex(content)}
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