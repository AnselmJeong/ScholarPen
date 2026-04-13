import React, { useState, useEffect, useRef, useCallback } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { ChevronLeft, ChevronRight, FileText, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import { rpc } from "../../rpc";
import type { FileNode } from "../../../shared/rpc-types";

// Worker MUST be configured in the same module as <Document> / <Page>
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

// Stable options — defined outside component to avoid re-renders triggering PDF reload
const PDF_OPTIONS = {
  cMapUrl: `https://unpkg.com/pdfjs-dist@${pdfjs.version}/cmaps/`,
  cMapPacked: true,
};

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3.0;

interface PdfViewerProps {
  file: FileNode;
}

export function PdfViewer({ file }: PdfViewerProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1.0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [baseWidth, setBaseWidth] = useState(600);

  // Load PDF binary via RPC → Blob URL
  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;

    setLoading(true);
    setError(null);
    setBlobUrl(null);
    setPageNumber(1);
    setNumPages(0);
    setZoom(1.0);

    rpc.readBinaryFile(file.path)
      .then((base64) => {
        if (cancelled) return;
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: "application/pdf" });
        createdUrl = URL.createObjectURL(blob);
        setBlobUrl(createdUrl);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || "Failed to load PDF");
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [file.path]);

  // Track container width for "fit to window" base size
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      if (entry) setBaseWidth(Math.max(entry.contentRect.width - 48, 300));
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Keyboard navigation: ← / → (or ↑ / ↓) for page, +/- for zoom
  // Only fires when the active element is not an editor/input
  useEffect(() => {
    if (!blobUrl) return;
    const handleKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      const isEditable =
        tag === "input" || tag === "textarea" || (e.target as HTMLElement)?.isContentEditable;
      if (isEditable) return;

      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
          if (numPages > 1) {
            e.preventDefault();
            setPageNumber((p) => Math.min(numPages, p + 1));
          }
          break;
        case "ArrowLeft":
        case "ArrowUp":
          if (numPages > 1) {
            e.preventDefault();
            setPageNumber((p) => Math.max(1, p - 1));
          }
          break;
        case "+":
        case "=":
          e.preventDefault();
          setZoom((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)));
          break;
        case "-":
          e.preventDefault();
          setZoom((z) => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)));
          break;
        case "0":
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            setZoom(1.0);
          }
          break;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [blobUrl, numPages]);

  const onDocumentLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
  }, []);

  const zoomIn = useCallback(() => setZoom((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2))), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2))), []);
  const zoomReset = useCallback(() => setZoom(1.0), []);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading {file.name}...</p>
      </div>
    );
  }

  if (error || !blobUrl) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-background gap-2">
        <FileText className="h-12 w-12 text-red-300" />
        <p className="text-sm text-foreground">{file.name}</p>
        <p className="text-xs text-red-400">{error || "Could not load PDF"}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="px-4 py-1.5 border-b border-border flex items-center gap-1 flex-shrink-0 bg-background">
        <FileText className="h-4 w-4 text-red-400 flex-shrink-0 mr-1" />
        <span className="text-sm text-muted-foreground font-medium truncate flex-1 min-w-0">{file.name}</span>

        {/* Zoom controls */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={zoomOut}
            disabled={zoom <= ZOOM_MIN}
            title="Zoom out (-)"
            className="p-1 rounded hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={zoomReset}
            title="Reset zoom (⌘0)"
            className="px-2 py-0.5 rounded hover:bg-accent transition-colors text-xs text-muted-foreground tabular-nums min-w-[3rem] text-center"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={zoomIn}
            disabled={zoom >= ZOOM_MAX}
            title="Zoom in (+)"
            className="p-1 rounded hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={zoomReset}
            title="Fit to window"
            className="p-1 rounded hover:bg-accent transition-colors ml-0.5"
          >
            <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>

        {/* Page count */}
        {numPages > 0 && (
          <span className="text-xs text-muted-foreground flex-shrink-0 ml-2 tabular-nums">
            {pageNumber} / {numPages}
          </span>
        )}
      </div>

      {/* PDF content — overflow-auto for horizontal scroll when zoomed in */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto flex flex-col items-center py-4 bg-muted/50"
      >
        <Document
          file={blobUrl}
          onLoadSuccess={onDocumentLoadSuccess}
          options={PDF_OPTIONS}
          loading={
            <div className="flex items-center justify-center p-8">
              <p className="text-sm text-gray-400">Rendering PDF...</p>
            </div>
          }
          error={
            <div className="flex items-center justify-center p-8">
              <p className="text-sm text-red-400">Failed to render PDF</p>
            </div>
          }
        >
          <Page
            pageNumber={pageNumber}
            width={baseWidth * zoom}
            renderTextLayer={true}
            renderAnnotationLayer={true}
            className="shadow-lg"
          />
        </Document>
      </div>

      {/* Pagination bar */}
      {numPages > 1 && (
        <div className="flex-shrink-0 flex items-center justify-center gap-3 py-2 border-t border-border bg-background">
          <button
            onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
            disabled={pageNumber <= 1}
            title="Previous page (← ↑)"
            className="p-1 rounded hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs text-muted-foreground select-none tabular-nums">
            Page {pageNumber} of {numPages}
          </span>
          <button
            onClick={() => setPageNumber((p) => Math.min(numPages, p + 1))}
            disabled={pageNumber >= numPages}
            title="Next page (→ ↓)"
            className="p-1 rounded hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
