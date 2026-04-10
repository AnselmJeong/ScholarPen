import React, { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileJson, FileText, BookOpen, Image as ImageIcon, File } from "lucide-react";
import { rpc } from "../../rpc";
import type { FileNode } from "../../../shared/rpc-types";

interface FileViewerProps {
  file: FileNode;
}

/** Simple syntax highlighting for BibTeX */
function highlightBibtex(code: string): React.ReactNode[] {
  const lines = code.split("\n");
  return lines.map((line, i) => {
    // Highlight @type{key,
    const highlighted = line
      .replace(/(@\w+)\{/g, '<span class="text-purple-600 font-semibold">$1</span>{')
      .replace(/(\w+)\s*=/g, '<span class="text-blue-600">$1</span> =')
      .replace(/("[^"]*")/g, '<span class="text-green-700">$1</span>')
      .replace(/(\d{4})/g, '<span class="text-orange-600">$1</span>');
    return (
      <div key={i} className="flex">
        <span className="w-10 text-right pr-3 text-gray-400 select-none text-xs leading-5">{i + 1}</span>
        <span
          className="flex-1 text-xs leading-5 font-mono whitespace-pre"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
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

export function FileViewer({ file }: FileViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  // Image viewer — use data URL directly
  if (file.kind === "figure") {
    const isDataUrl = file.path.startsWith("data:");
    const ext = getExt(file.name).toLowerCase();
    const isImage = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"].includes(ext);

    if (isImage) {
      // For project-local images, we can't load them via file:// in webview,
      // so we show a placeholder with the path
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-8 bg-white">
          <ImageIcon className="h-16 w-16 text-gray-300 mb-4" />
          <p className="text-sm text-gray-500 mb-1">{file.name}</p>
          <p className="text-xs text-gray-400">{file.path}</p>
        </div>
      );
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-white">
        <p className="text-gray-400">Loading {file.name}...</p>
      </div>
    );
  }

  if (error || content === null) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-white">
        {getFileIcon(file.kind)}
        <p className="mt-2 text-sm text-gray-700">{file.name}</p>
        <p className="text-xs text-red-400 mt-1">{error || "Could not read file"}</p>
      </div>
    );
  }

  const ext = getExt(file.name).toLowerCase();
  const isMarkdown = [".md", ".qmd", ".markdown"].includes(ext);
  const isBibtex = ext === ".bib";
  const isCode = [".txt", ".json", ".yaml", ".yml", ".toml", ".tex", ".cls", ".sty", ".bst"].includes(ext);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white">
      {/* Header */}
      <div className="px-6 py-2 border-b border-gray-100 text-sm text-gray-500 font-medium flex items-center gap-2">
        {getFileIcon(file.kind)}
        <span>{file.name}</span>
        {isBibtex && <span className="text-xs text-gray-400 ml-2">BibTeX</span>}
        {isMarkdown && <span className="text-xs text-gray-400 ml-2">Markdown</span>}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {isMarkdown && (
          <div className="max-w-3xl mx-auto px-8 py-6 prose prose-sm prose-gray">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {content}
            </ReactMarkdown>
          </div>
        )}

        {isBibtex && (
          <div className="max-w-4xl mx-auto px-4 py-4 bg-gray-50 border border-gray-200 rounded-lg m-4">
            <div className="overflow-x-auto">
              {highlightBibtex(content)}
            </div>
          </div>
        )}

        {isCode && (
          <div className="max-w-4xl mx-auto px-4 py-4 bg-gray-50 border border-gray-200 rounded-lg m-4">
            <div className="overflow-x-auto">
              <pre className="text-xs font-mono whitespace-pre text-gray-800">{content}</pre>
            </div>
          </div>
        )}

        {!isMarkdown && !isBibtex && !isCode && (
          <div className="max-w-4xl mx-auto px-4 py-4 bg-gray-50 border border-gray-200 rounded-lg m-4">
            <div className="overflow-x-auto">
              <pre className="text-xs font-mono whitespace-pre text-gray-800">{content}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}