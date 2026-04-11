// Knowledge Base FTS5 search engine
// Uses bun:sqlite (built-in) — no extra packages required.
// Index lives at <kbRoot>/.kb-index.sqlite and is built on first use.

import { Database } from "bun:sqlite";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

export interface KBSearchResult {
  docId: string;
  docType: string;
  title: string;
  filePath: string;
  excerpt: string;
  score: number;
}

export interface KBStatus {
  exists: boolean;
  kbRoot: string | null;
  pageCount: number;
  lastIndexed: number | null;
}

// Bump this whenever cleanBody or indexing logic changes to force a rebuild.
const INDEX_VERSION = "2";

// Wiki subdirectories to index (schema.md page types)
const WIKI_SUBDIRS = [
  "sources", "concepts", "entities", "synthesis",
  "findings", "thesis", "queries", "methodology", "comparisons",
];

// ── KB root detection ──────────────────────────────────────────────────────────

export async function findKBRoot(projectPath: string): Promise<string | null> {
  const candidates = [
    join(projectPath, "knowledge-base"),
    join(projectPath, "Knowledge_base"),
    join(projectPath, "Knowledge_Base"),
  ];
  for (const candidate of candidates) {
    // Primary marker: schema.md (present in all new-format KBs)
    if (existsSync(join(candidate, "schema.md"))) return candidate;
    // Fallback: wiki/index.md
    if (existsSync(join(candidate, "wiki", "index.md"))) return candidate;
  }
  return null;
}

// ── Frontmatter parser ─────────────────────────────────────────────────────────
// Minimal — only extracts `type` and `title` reliably.

function parseMd(content: string): { type: string; title: string; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    const h1 = content.match(/^#\s+(.+)$/m);
    return { type: "unknown", title: h1?.[1]?.trim() ?? "", body: content };
  }

  const yaml = match[1];
  const body = match[2];
  let type = "unknown";
  let title = "";

  for (const line of yaml.split("\n")) {
    if (!type || type === "unknown") {
      const m = line.match(/^type:\s*(.+)$/);
      if (m) type = m[1].trim().replace(/['"]/g, "");
    }
    if (!title) {
      const m = line.match(/^title:\s*(.+)$/);
      if (m) title = m[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  // Fallback: first h1 in body
  if (!title) {
    const h1 = body.match(/^#\s+(.+)$/m);
    title = h1?.[1]?.trim() ?? "";
  }

  return { type, title, body };
}

// Convert markdown to plain text suitable for FTS5 indexing.
// Key rule: keep all text content — especially table cell values,
// since source files store entities/concepts in markdown tables.
function cleanBody(raw: string): string {
  return raw
    // Table separator rows (|:---|:---| etc.) → remove entirely
    .replace(/^\|[\s|:-]+\|$/gm, " ")
    // Table data rows: strip pipes, keep cell text
    .replace(/\|/g, " ")
    // Headings: remove # markers but keep text
    .replace(/^#{1,6}\s+/gm, " ")
    // Bold/italic markers
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    // Wikilinks [[text]] → text
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    // Inline code `text` → text
    .replace(/`([^`]+)`/g, "$1")
    // Collapse excess whitespace
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Sanitize user query for FTS5 — remove special chars, keep words
function safeFtsQuery(text: string): string {
  const words = text
    .replace(/[^\w\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 2); // skip very short tokens
  if (words.length === 0) return '""'; // empty match — returns nothing
  return words.join(" ");
}

// ── Engine singleton cache ─────────────────────────────────────────────────────

const engineCache = new Map<string, KBSearchEngine>();

export function getKBEngine(kbRoot: string): KBSearchEngine {
  if (!engineCache.has(kbRoot)) {
    engineCache.set(kbRoot, new KBSearchEngine(kbRoot));
  }
  return engineCache.get(kbRoot)!;
}

// ── KBSearchEngine ─────────────────────────────────────────────────────────────

export class KBSearchEngine {
  private db: Database;
  private kbRoot: string;
  private indexed = false;
  private indexingPromise: Promise<void> | null = null;

  constructor(kbRoot: string) {
    this.kbRoot = kbRoot;
    const dbPath = join(kbRoot, ".kb-index.sqlite");
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.initSchema();
    // Pre-check: if index already has data AND correct version, mark as ready
    const versionRow = this.db.query(
      "SELECT value FROM kb_info WHERE key = 'index_version'"
    ).get() as { value: string } | null;
    const countRow = this.db.query(
      "SELECT value FROM kb_info WHERE key = 'page_count'"
    ).get() as { value: string } | null;
    this.indexed =
      versionRow?.value === INDEX_VERSION &&
      countRow !== null &&
      parseInt(countRow.value, 10) > 0;
  }

  private initSchema(): void {
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
        doc_id,
        doc_type,
        title,
        content,
        tokenize = "porter ascii"
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS doc_meta (
        doc_id   TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        doc_type  TEXT,
        title     TEXT
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS kb_info (
        key   TEXT PRIMARY KEY,
        value TEXT
      )
    `);
  }

  // Trigger indexing; safe to call multiple times (deduplicates)
  ensureIndexed(): Promise<void> {
    if (this.indexed) return Promise.resolve();
    if (!this.indexingPromise) {
      this.indexingPromise = this.buildIndex().catch((err) => {
        console.error("[KB] Index build failed:", err);
        this.indexingPromise = null; // allow retry
      });
    }
    return this.indexingPromise;
  }

  async buildIndex(): Promise<void> {
    console.log(`[KB] Building FTS5 index for ${this.kbRoot}`);

    this.db.run("DELETE FROM docs");
    this.db.run("DELETE FROM doc_meta");

    const insertDoc = this.db.prepare(
      "INSERT INTO docs(doc_id, doc_type, title, content) VALUES (?, ?, ?, ?)"
    );
    const insertMeta = this.db.prepare(
      "INSERT OR REPLACE INTO doc_meta(doc_id, file_path, doc_type, title) VALUES (?, ?, ?, ?)"
    );

    let count = 0;
    const wikiDir = join(this.kbRoot, "wiki");

    // Index each wiki subdirectory
    for (const subdir of WIKI_SUBDIRS) {
      const dir = join(wikiDir, subdir);
      if (!existsSync(dir)) continue;
      try {
        const files = await readdir(dir);
        for (const file of files) {
          if (!file.endsWith(".md")) continue;
          const filePath = join(dir, file);
          const raw = await readFile(filePath, "utf8");
          const { type, title, body } = parseMd(raw);
          const docId = `${subdir}/${file.slice(0, -3)}`; // strip .md
          const docType = type !== "unknown" ? type : subdir.replace(/s$/, ""); // "sources"→"source"
          insertDoc.run(docId, docType, title, cleanBody(body));
          insertMeta.run(docId, filePath, docType, title);
          count++;
        }
      } catch (err) {
        console.warn(`[KB] Could not scan ${dir}:`, err);
      }
    }

    // Also index wiki/overview.md for project-level context
    const overviewPath = join(wikiDir, "overview.md");
    if (existsSync(overviewPath)) {
      const raw = await readFile(overviewPath, "utf8");
      const { type, title, body } = parseMd(raw);
      insertDoc.run("overview", type || "overview", title || "Project Overview", cleanBody(body));
      insertMeta.run("overview", overviewPath, "overview", title || "Project Overview");
      count++;
    }

    this.db.run(
      "INSERT OR REPLACE INTO kb_info(key, value) VALUES ('page_count', ?)",
      [String(count)]
    );
    this.db.run(
      "INSERT OR REPLACE INTO kb_info(key, value) VALUES ('last_indexed', ?)",
      [String(Date.now())]
    );
    this.db.run(
      "INSERT OR REPLACE INTO kb_info(key, value) VALUES ('index_version', ?)",
      [INDEX_VERSION]
    );

    this.indexed = true;
    console.log(`[KB] Indexed ${count} pages`);
  }

  search(query: string, limit = 5): KBSearchResult[] {
    if (!this.indexed) return [];
    const ftsQuery = safeFtsQuery(query);
    if (ftsQuery === '""') return [];
    try {
      return this.db.query(`
        SELECT
          m.doc_id   AS docId,
          m.doc_type AS docType,
          m.title    AS title,
          m.file_path AS filePath,
          snippet(docs, 3, '', '', '…', 30) AS excerpt,
          bm25(docs) AS score
        FROM docs
        JOIN doc_meta m ON docs.doc_id = m.doc_id
        WHERE docs MATCH ?
        ORDER BY bm25(docs)
        LIMIT ?
      `).all(ftsQuery, limit) as KBSearchResult[];
    } catch (err) {
      console.warn("[KB] FTS5 search error:", err);
      return [];
    }
  }

  getStatus(): { pageCount: number; lastIndexed: number | null } {
    const countRow = this.db
      .query("SELECT value FROM kb_info WHERE key = 'page_count'")
      .get() as { value: string } | null;
    const timeRow = this.db
      .query("SELECT value FROM kb_info WHERE key = 'last_indexed'")
      .get() as { value: string } | null;
    return {
      pageCount: countRow ? parseInt(countRow.value, 10) : 0,
      lastIndexed: timeRow ? parseInt(timeRow.value, 10) : null,
    };
  }

  // Force full rebuild (called from UI "Rebuild Index" button)
  async rebuild(): Promise<void> {
    this.indexed = false;
    this.indexingPromise = null;
    await this.buildIndex();
  }
}
