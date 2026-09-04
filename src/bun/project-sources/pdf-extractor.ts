import { readFile, stat } from "fs/promises";

type PdfJsModule = typeof import("pdfjs-dist/build/pdf.mjs");

let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

/**
 * PDF.js' modern build only touches DOMMatrix in rendering code, but creates
 * one identity instance during module initialization. ScholarPen extracts text
 * only, so a small 2D implementation keeps the Bun package canvas-free.
 */
class TextOnlyDOMMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(values?: readonly number[]) {
    if (!values || values.length < 6) return;
    [this.a, this.b, this.c, this.d, this.e, this.f] = values;
  }

  get is2D(): boolean { return true; }
  get isIdentity(): boolean {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }

  multiplySelf(other: TextOnlyDOMMatrix): this {
    const { a, b, c, d, e, f } = this;
    this.a = a * other.a + c * other.b;
    this.b = b * other.a + d * other.b;
    this.c = a * other.c + c * other.d;
    this.d = b * other.c + d * other.d;
    this.e = a * other.e + c * other.f + e;
    this.f = b * other.e + d * other.f + f;
    return this;
  }

  preMultiplySelf(other: TextOnlyDOMMatrix): this {
    const current = new TextOnlyDOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]);
    this.a = other.a; this.b = other.b; this.c = other.c;
    this.d = other.d; this.e = other.e; this.f = other.f;
    return this.multiplySelf(current);
  }

  translate(x = 0, y = 0): TextOnlyDOMMatrix {
    return new TextOnlyDOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f])
      .multiplySelf(new TextOnlyDOMMatrix([1, 0, 0, 1, x, y]));
  }

  scale(scaleX = 1, scaleY = scaleX): TextOnlyDOMMatrix {
    return new TextOnlyDOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f])
      .multiplySelf(new TextOnlyDOMMatrix([scaleX, 0, 0, scaleY, 0, 0]));
  }

  invertSelf(): this {
    const determinant = this.a * this.d - this.b * this.c;
    if (determinant === 0) return this;
    const { a, b, c, d, e, f } = this;
    this.a = d / determinant;
    this.b = -b / determinant;
    this.c = -c / determinant;
    this.d = a / determinant;
    this.e = (c * f - d * e) / determinant;
    this.f = (b * e - a * f) / determinant;
    return this;
  }
}

function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsModulePromise) {
    if (!("DOMMatrix" in globalThis)) {
      Object.defineProperty(globalThis, "DOMMatrix", {
        configurable: true,
        value: TextOnlyDOMMatrix,
        writable: true,
      });
    }
    // Do not make this a static import: the packaged main process must be able
    // to start without evaluating PDF.js or resolving optional canvas modules.
    pdfJsModulePromise = import("pdfjs-dist/build/pdf.mjs");
  }
  return pdfJsModulePromise;
}

const MAX_PDF_BYTES = 80 * 1024 * 1024;
const MAX_PDF_PAGES = 120;

export interface ExtractedPdfPage {
  pageNumber: number;
  content: string;
}

export interface ExtractedPdf {
  pageCount: number;
  pages: ExtractedPdfPage[];
}

function textItem(value: unknown): string {
  if (!value || typeof value !== "object" || !("str" in value)) return "";
  const str = (value as { str?: unknown }).str;
  return typeof str === "string" ? str : "";
}

export async function extractPdfPages(
  filePath: string,
  requestedPages?: readonly number[],
  signal?: AbortSignal,
): Promise<ExtractedPdf> {
  const info = await stat(filePath);
  if (info.size > MAX_PDF_BYTES) throw new Error("PDF exceeds the 80 MB extraction limit.");
  signal?.throwIfAborted();
  const bytes = await readFile(filePath);
  signal?.throwIfAborted();
  const { getDocument } = await loadPdfJs();
  const loadingTask = getDocument({ data: new Uint8Array(bytes) });
  const document = await loadingTask.promise;
  try {
    if (document.numPages > MAX_PDF_PAGES && !requestedPages?.length) {
      throw new Error("PDF exceeds the 120 page full-text extraction limit.");
    }
    const pages = requestedPages?.length
      ? [...new Set(requestedPages)].filter((page) => page >= 1 && page <= document.numPages).sort((a, b) => a - b)
      : Array.from({ length: document.numPages }, (_, index) => index + 1);
    const extracted: ExtractedPdfPage[] = [];
    for (const pageNumber of pages) {
      signal?.throwIfAborted();
      const page = await document.getPage(pageNumber);
      const text = await page.getTextContent();
      const content = text.items.map(textItem).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      extracted.push({ pageNumber, content });
      page.cleanup();
    }
    return { pageCount: document.numPages, pages: extracted };
  } finally {
    await document.destroy();
  }
}
