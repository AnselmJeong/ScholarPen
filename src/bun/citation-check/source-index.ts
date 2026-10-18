import { Database } from "bun:sqlite";
import { mkdir, readdir, stat } from "fs/promises";
import { basename, join, sep } from "path";
import type { BibtexEntry } from "../../shared/bibtex-utils";
import type { CitationSourcesStatus } from "../../shared/rpc-types";
import { extractPdfPages, type ExtractedPdf } from "../project-sources/pdf-extractor";
import { chunkPdfPages, cleanDoi, detectDois, ftsQueryFor, squash, type PdfChunkKind } from "./pdf-text";

/** Bump when chunking changes so every PDF is extracted again. */
const SCHEMA_VERSION = "1";
// Books are sources too: index them whole, in the background, once.
const MAX_INDEX_PAGES = 3_000;
const MAX_INDEX_BYTES = 400 * 1024 * 1024;
const HEAD_CHARS = 6_000;
const MIN_TEXT_CHARS = 200;
const ABSTRACT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MISSING_ABSTRACT_TTL_MS = 3 * 24 * 60 * 60 * 1000;

type PdfStatus = "indexed" | "no-text" | "failed";

interface PdfRow {
  id: number;
  relpath: string;
  status: PdfStatus;
  dois_json: string;
  head_squash: string;
  name_squash: string;
}

export interface PdfPassage {
  id: number;
  page: number;
  kind: PdfChunkKind;
  content: string;
}

export interface PdfLink {
  pdfId: number;
  relpath: string;
  status: PdfStatus;
  /** How the PDF was matched to the bibliography entry. */
  method: "doi+title" | "title" | "doi";
}

export interface CachedAbstract {
  abstract: string | null;
  title: string | null;
  retracted: boolean;
}

type Extract = (filePath: string, pages?: readonly number[]) => Promise<ExtractedPdf>;

const PAGE_RANGE = Array.from({ length: MAX_INDEX_PAGES }, (_, index) => index + 1);

function titleKey(entry: BibtexEntry): string {
  const title = squash(entry.fields.title ?? "");
  return title.length >= 20 ? title.slice(0, 60) : "";
}

function titleWords(entry: BibtexEntry): string[] {
  return (entry.fields.title ?? "").toLowerCase().match(/[\p{L}\p{N}]{4,}/gu)?.map(squash) ?? [];
}

/**
 * Extracted text of the PDFs a project keeps under resources/, chunked and indexed
 * once (again only when a file changes), plus a cache of OpenAlex abstracts for
 * cited works without a PDF. Lives in db/citation-sources.sqlite.
 */
export class CitationSourceIndex {
  private db: Promise<Database> | null = null;
  private scanning: Promise<void> | null = null;
  private rescanRequested = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastError: string | undefined;
  private progress = { done: 0, total: 0 };

  constructor(
    readonly projectPath: string,
    private readonly extract: Extract = (filePath, pages) => extractPdfPages(filePath, pages, undefined, { maxBytes: MAX_INDEX_BYTES }),
  ) {}

  /** Opens the database once, even when several callers ask at the same time. */
  private ready(): Promise<Database> {
    this.db ??= this.open().catch(error => { this.db = null; throw error; });
    return this.db;
  }

  private async open(): Promise<Database> {
    await mkdir(join(this.projectPath, "db"), { recursive: true });
    const db = new Database(join(this.projectPath, "db", "citation-sources.sqlite"));
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA busy_timeout = 5000");
    db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.run(`CREATE TABLE IF NOT EXISTS pdfs (
      id INTEGER PRIMARY KEY,
      relpath TEXT NOT NULL UNIQUE,
      mtime_ms REAL NOT NULL,
      size_bytes INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      page_count INTEGER,
      dois_json TEXT NOT NULL DEFAULT '[]',
      head_squash TEXT NOT NULL DEFAULT '',
      name_squash TEXT NOT NULL DEFAULT '',
      indexed_at INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS pdf_chunks (
      id INTEGER PRIMARY KEY,
      pdf_id INTEGER NOT NULL REFERENCES pdfs(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      page INTEGER NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL
    )`);
    db.run("CREATE INDEX IF NOT EXISTS idx_pdf_chunks_pdf ON pdf_chunks(pdf_id, ordinal)");
    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS pdf_chunks_fts USING fts5(
      content, content='pdf_chunks', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2'
    )`);
    db.run(`CREATE TRIGGER IF NOT EXISTS pdf_chunks_ai AFTER INSERT ON pdf_chunks BEGIN
      INSERT INTO pdf_chunks_fts(rowid, content) VALUES (new.id, new.content);
    END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS pdf_chunks_ad AFTER DELETE ON pdf_chunks BEGIN
      INSERT INTO pdf_chunks_fts(pdf_chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END`);
    db.run(`CREATE TABLE IF NOT EXISTS abstracts (
      key TEXT PRIMARY KEY,
      abstract TEXT,
      title TEXT,
      retracted INTEGER NOT NULL DEFAULT 0,
      fetched_at INTEGER NOT NULL
    )`);
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null;
    if (version?.value !== SCHEMA_VERSION) {
      db.run("DELETE FROM pdf_chunks");
      db.run("DELETE FROM pdfs");
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
    }
    return db;
  }

  /** Debounced background scan, for file-watcher events. */
  scheduleScan(delayMs = 2_000): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scan().catch(error => console.warn("[CitationSources] PDF indexing failed:", error));
    }, delayMs);
  }

  /** Index new or changed PDFs and forget removed ones. Concurrent calls share one run. */
  scan(): Promise<void> {
    if (this.scanning) {
      this.rescanRequested = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      do {
        this.rescanRequested = false;
        await this.scanOnce();
      } while (this.rescanRequested);
    })().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  get isScanning(): boolean {
    return this.scanning !== null;
  }

  private async listPdfs(): Promise<string[]> {
    const root = join(this.projectPath, "resources");
    let entries: string[];
    try {
      entries = await readdir(root, { recursive: true }) as string[];
    } catch {
      return [];
    }
    return entries
      .map(entry => entry.split(sep).join("/"))
      .filter(entry => /\.pdf$/i.test(entry) && !entry.split("/").some(part => part.startsWith(".")))
      .map(entry => `resources/${entry}`)
      .sort();
  }

  private async scanOnce(): Promise<void> {
    const db = await this.ready();
    try {
      const files = await this.listPdfs();
      const rows = db.query("SELECT id, relpath, mtime_ms, size_bytes FROM pdfs").all() as Array<{ id: number; relpath: string; mtime_ms: number; size_bytes: number }>;
      const known = new Map(rows.map(row => [row.relpath, row]));
      const present = new Set<string>();
      const changed: Array<{ relpath: string; mtimeMs: number; size: number }> = [];
      for (const relpath of files) {
        const info = await stat(join(this.projectPath, relpath)).catch(() => null);
        if (!info?.isFile()) continue;
        present.add(relpath);
        const row = known.get(relpath);
        if (!row || row.mtime_ms !== info.mtimeMs || row.size_bytes !== info.size) {
          changed.push({ relpath, mtimeMs: info.mtimeMs, size: info.size });
        }
      }
      const removed = rows.filter(row => !present.has(row.relpath));
      for (const row of removed) this.remove(db, row.id);
      this.progress = { done: 0, total: changed.length };
      for (const file of changed) {
        await this.indexPdf(db, file);
        this.progress.done += 1;
        // Give RPC traffic a turn between files.
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private remove(db: Database, id: number): void {
    db.query("DELETE FROM pdf_chunks WHERE pdf_id = ?").run(id);
    db.query("DELETE FROM pdfs WHERE id = ?").run(id);
  }

  private async indexPdf(db: Database, file: { relpath: string; mtimeMs: number; size: number }): Promise<void> {
    let status: PdfStatus = "indexed";
    let error: string | null = null;
    let pageCount: number | null = null;
    let head = "";
    let chunks: ReturnType<typeof chunkPdfPages> = [];
    try {
      const extracted = await this.extract(join(this.projectPath, file.relpath), PAGE_RANGE);
      pageCount = extracted.pageCount;
      head = extracted.pages.slice(0, 2).map(page => page.content).join(" ");
      const textLength = extracted.pages.reduce((sum, page) => sum + page.content.trim().length, 0);
      if (textLength < MIN_TEXT_CHARS) status = "no-text";
      else chunks = chunkPdfPages(extracted.pages);
    } catch (cause) {
      status = "failed";
      error = cause instanceof Error ? cause.message : String(cause);
    }
    db.run("BEGIN IMMEDIATE");
    try {
      const existing = db.query("SELECT id FROM pdfs WHERE relpath = ?").get(file.relpath) as { id: number } | null;
      if (existing) this.remove(db, existing.id);
      const row = db.query(`INSERT INTO pdfs (relpath, mtime_ms, size_bytes, status, error, page_count, dois_json, head_squash, name_squash, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(
        file.relpath, file.mtimeMs, file.size, status, error, pageCount,
        JSON.stringify(detectDois(head)), squash(head).slice(0, HEAD_CHARS),
        squash(basename(file.relpath).replace(/\.pdf$/i, "")), Date.now(),
      ) as { id: number };
      const insert = db.query("INSERT INTO pdf_chunks (pdf_id, ordinal, page, kind, content) VALUES (?, ?, ?, ?, ?)");
      for (const chunk of chunks) insert.run(row.id, chunk.ordinal, chunk.page, chunk.kind, chunk.content);
      db.run("COMMIT");
    } catch (cause) {
      db.run("ROLLBACK");
      throw cause;
    }
  }

  async status(): Promise<CitationSourcesStatus> {
    const db = await this.ready();
    const counts = db.query("SELECT status, COUNT(*) AS count FROM pdfs GROUP BY status").all() as Array<{ status: PdfStatus; count: number }>;
    const count = (status: PdfStatus) => counts.find(row => row.status === status)?.count ?? 0;
    const failures = db.query("SELECT relpath, status, error FROM pdfs WHERE status != 'indexed' ORDER BY relpath LIMIT 50")
      .all() as Array<{ relpath: string; status: PdfStatus; error: string | null }>;
    return {
      pdfCount: counts.reduce((sum, row) => sum + row.count, 0),
      indexedCount: count("indexed"),
      noTextCount: count("no-text"),
      failedCount: count("failed"),
      unreadable: failures.map(row => ({ relpath: row.relpath, reason: row.status === "no-text" ? "텍스트 없음 (스캔본)" : row.error ?? "추출 실패" })),
      indexing: this.isScanning,
      progress: this.isScanning ? { ...this.progress } : null,
      lastError: this.lastError,
    };
  }

  /**
   * Finds each entry's PDF: a DOI printed on its first pages, its title on the
   * first pages or in the file name, or both. A PDF whose DOI is all that matches
   * must share most of the entry's title words, and a PDF that matches another
   * entry more strongly (e.g. a cited DOI on its first page) is left to that entry.
   */
  async linkEntries(entries: readonly BibtexEntry[], only?: ReadonlySet<string>): Promise<Map<string, PdfLink>> {
    const db = await this.ready();
    const pdfs = (db.query("SELECT id, relpath, status, dois_json, head_squash, name_squash FROM pdfs").all() as PdfRow[])
      .map(row => ({ ...row, dois: JSON.parse(row.dois_json) as string[] }));
    const prepared = entries.map(entry => ({
      entry, doi: cleanDoi(entry.fields.doi ?? ""), title: titleKey(entry), words: titleWords(entry),
    }));
    type Prepared = typeof prepared[number];
    const score = (item: Prepared, pdf: typeof pdfs[number]): number => {
      const doiHit = Boolean(item.doi) && pdf.dois.includes(item.doi);
      const titleHit = Boolean(item.title) && (pdf.head_squash.includes(item.title) ||
        (item.title.length >= 40 && pdf.name_squash.includes(item.title.slice(0, 40))));
      if (doiHit && titleHit) return 3;
      if (titleHit) return 2;
      if (doiHit) {
        if (!item.words.length) return 1;
        const shared = item.words.filter(word => pdf.head_squash.includes(word)).length;
        return shared / item.words.length >= 0.5 ? 1 : 0;
      }
      return 0;
    };
    const links = new Map<string, PdfLink>();
    for (const item of prepared) {
      if (only && !only.has(item.entry.citekey)) continue;
      const candidates = pdfs.map(pdf => ({ pdf, score: score(item, pdf) }))
        .filter(candidate => candidate.score > 0)
        .sort((a, b) => b.score - a.score || Number(b.pdf.status === "indexed") - Number(a.pdf.status === "indexed"));
      for (const { pdf, score: own } of candidates) {
        // Duplicate entries of the same work may share a PDF.
        const duplicate = (other: Prepared) => (Boolean(item.doi) && other.doi === item.doi) || (Boolean(item.title) && other.title === item.title);
        const contested = prepared.some(other => other !== item && !duplicate(other) && score(other, pdf) > own);
        if (contested) continue;
        links.set(item.entry.citekey, {
          pdfId: pdf.id, relpath: pdf.relpath, status: pdf.status,
          method: own === 3 ? "doi+title" : own === 2 ? "title" : "doi",
        });
        break;
      }
    }
    return links;
  }

  /** Title, authors and abstract: the start of page 1. */
  async lead(pdfId: number): Promise<PdfPassage[]> {
    const db = await this.ready();
    return db.query("SELECT id, page, kind, content FROM pdf_chunks WHERE pdf_id = ? AND kind = 'lead' ORDER BY ordinal LIMIT 2")
      .all(pdfId) as PdfPassage[];
  }

  /** The body passages of one PDF that best match any of the queries (BM25). */
  async search(pdfId: number, queries: readonly string[], limit = 4, exclude: ReadonlySet<number> = new Set()): Promise<PdfPassage[]> {
    const db = await this.ready();
    const match = ftsQueryFor(queries);
    if (!match) return [];
    const rows = db.query(`SELECT c.id, c.page, c.kind, c.content
      FROM pdf_chunks_fts JOIN pdf_chunks c ON c.id = pdf_chunks_fts.rowid
      WHERE pdf_chunks_fts MATCH ? AND c.pdf_id = ? AND c.kind = 'body'
      ORDER BY bm25(pdf_chunks_fts) LIMIT ?`).all(match, pdfId, limit + exclude.size + 2) as PdfPassage[];
    return rows.filter(row => !exclude.has(row.id)).slice(0, limit);
  }

  async cachedAbstract(key: string): Promise<CachedAbstract | undefined> {
    const db = await this.ready();
    const row = db.query("SELECT abstract, title, retracted, fetched_at FROM abstracts WHERE key = ?").get(key) as
      { abstract: string | null; title: string | null; retracted: number; fetched_at: number } | null;
    if (!row) return undefined;
    const ttl = row.abstract ? ABSTRACT_TTL_MS : MISSING_ABSTRACT_TTL_MS;
    if (Date.now() - row.fetched_at > ttl) return undefined;
    return { abstract: row.abstract, title: row.title, retracted: row.retracted === 1 };
  }

  async storeAbstract(key: string, value: CachedAbstract): Promise<void> {
    const db = await this.ready();
    db.query("INSERT OR REPLACE INTO abstracts (key, abstract, title, retracted, fetched_at) VALUES (?, ?, ?, ?, ?)")
      .run(key, value.abstract, value.title, value.retracted ? 1 : 0, Date.now());
  }
}

const indexes = new Map<string, CitationSourceIndex>();

export function getCitationSourceIndex(projectPath: string): CitationSourceIndex {
  let index = indexes.get(projectPath);
  if (!index) {
    index = new CitationSourceIndex(projectPath);
    indexes.set(projectPath, index);
  }
  return index;
}

/** PDFs anywhere under resources/ are cited sources. */
export function isCitationSourcePdfPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  return normalized.startsWith("resources/") && normalized.endsWith(".pdf");
}
