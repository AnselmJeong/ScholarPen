// Knowledge Base FTS5 search engine
// Uses bun:sqlite (built-in) — no extra packages required.
// Index lives at <kbRoot>/.kb-index.sqlite and is built on first use.

import { Database } from "bun:sqlite";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { parse as parseYaml } from "yaml";

export interface KBSearchResult {
  docId: string;
  docType: string;
  title: string;
  filePath: string;
  excerpt: string;
  score: number;
  authors: string[];
  year: number | undefined;
}

export interface KBStatus {
  exists: boolean;
  kbRoot: string | null;
  pageCount: number;
  lastIndexed: number | null;
}

// Bump this whenever cleanBody or indexing logic changes to force a rebuild.
const INDEX_VERSION = "4";

// Wiki subdirectories to index (schema.md page types)
const WIKI_SUBDIRS = [
  "sources", "concepts", "entities", "synthesis",
  "findings", "thesis", "queries", "methodology", "comparisons", "reports",
];

// Singular form lookup for subdirectory names that don't follow simple plural rules
const DIR_TO_TYPE: Record<string, string> = {
  sources: "source",
  concepts: "concept",
  entities: "entity",
  synthesis: "synthesis",
  findings: "finding",
  thesis: "thesis",
  queries: "query",
  methodology: "methodology",
  comparisons: "comparison",
  reports: "report",
};

// ── KB root detection ──────────────────────────────────────────────────────────

export async function findKBRoot(projectPath: string): Promise<string | null> {
  const candidates = [
    join(projectPath, "Knowledge_Base"),
    join(projectPath, "Knowledge_base"),
    join(projectPath, "knowledge-base"),
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

interface ParsedMd {
  type: string;
  title: string;
  body: string;
  authors: string[];
  year: number | undefined;
}

function parseMd(content: string): ParsedMd {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    const h1 = content.match(/^#\s+(.+)$/m);
    return { type: "unknown", title: h1?.[1]?.trim() ?? "", body: content, authors: [], year: undefined };
  }

  const yaml = match[1];
  const body = match[2];
  let type = "unknown";
  let title = "";
  let authors: string[] = [];
  let year: number | undefined = undefined;

  for (const line of yaml.split("\n")) {
    if (!type || type === "unknown") {
      const m = line.match(/^type:\s*(.+)$/);
      if (m) type = m[1].trim().replace(/['"]/g, "");
    }
    if (!title) {
      const m = line.match(/^title:\s*(.+)$/);
      if (m) title = m[1].trim().replace(/^["']|["']$/g, "");
    }
    // Parse YAML list: authors: [Author1, Author2] or multiline
    if (line.match(/^authors:\s*\[/)) {
      const items = line.match(/\[(.+)\]/);
      if (items) authors = items[1].split(",").map(a => a.trim().replace(/^["']|["']$/g, ""));
    } else if (line.match(/^\s+-\s+/) && authors.length === 0 && yaml.includes("authors:")) {
      // Multi-line YAML list item after "authors:" key
      const item = line.replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, "");
      if (item) authors.push(item);
    }
    if (year === undefined) {
      const m = line.match(/^year:\s*(\d{4})/);
      if (m) year = parseInt(m[1], 10);
    }
  }

  // Fallback: first h1 in body
  if (!title) {
    const h1 = body.match(/^#\s+(.+)$/m);
    title = h1?.[1]?.trim() ?? "";
  }

  return { type, title, body, authors, year };
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

// Sanitize user query for FTS5 — remove FTS special chars, keep Unicode words.
// Uses Unicode-aware regex so Korean/CJK characters are preserved for search.
// Terms joined with OR for broader recall (any matching doc is surfaced).
function safeFtsQuery(text: string): string {
  const words = text
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // keep Unicode letters & digits (incl. Korean)
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1); // 2+ chars: handles short Korean words like 구속, 연구
  if (words.length === 0) return '""'; // empty match — returns nothing
  return words.join(" OR "); // OR logic: any word match qualifies
}

// ── YAML index loader ──────────────────────────────────────────────────────────

interface PaperEntry {
  id: string;
  title: string;
  authors: string[];
  year: number;
  wiki_slug: string;
  one_line_finding?: string;
  study_type?: string;
  llm_keywords: string[];
}

interface MasterIndex {
  papers: PaperEntry[];
  last_updated: string;
}

interface KeywordEntry {
  count: number;
  papers: string[];
}

type KeywordRegistry = Record<string, KeywordEntry>;

/** Load and parse wiki/index/master_index.yaml for enriched metadata */
async function loadMasterIndex(kbRoot: string): Promise<MasterIndex | null> {
  const indexPath = join(kbRoot, "wiki", "index", "master_index.yaml");
  if (!existsSync(indexPath)) return null;
  try {
    const raw = await readFile(indexPath, "utf8");
    // Minimal YAML parser for the flat structure we expect
    // The file has: papers: [...] and last_updated: '...'
    const data = parseYaml(raw) as Record<string, unknown>;
    if (data && Array.isArray(data.papers)) {
      return {
        papers: data.papers as PaperEntry[],
        last_updated: (data.last_updated as string) ?? "",
      };
    }
    return null;
  } catch (err) {
    console.warn("[KB] Could not load master_index.yaml:", err);
    return null;
  }
}

/** Load and parse wiki/index/keyword_registry.yaml */
async function loadKeywordRegistry(kbRoot: string): Promise<KeywordRegistry | null> {
  const kwPath = join(kbRoot, "wiki", "index", "keyword_registry.yaml");
  if (!existsSync(kwPath)) return null;
  try {
    const raw = await readFile(kwPath, "utf8");
    const data = parseYaml(raw) as Record<string, unknown>;
    return data as unknown as KeywordRegistry;
  } catch (err) {
    console.warn("[KB] Could not load keyword_registry.yaml:", err);
    return null;
  }
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
  private masterIndex: MasterIndex | null = null;
  private keywordRegistry: KeywordRegistry | null = null;

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
        title     TEXT,
        authors   TEXT,
        year      INTEGER
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
      "INSERT OR REPLACE INTO doc_meta(doc_id, file_path, doc_type, title, authors, year) VALUES (?, ?, ?, ?, ?, ?)"
    );

    // Load YAML index files for enriched metadata
    this.masterIndex = await loadMasterIndex(this.kbRoot);
    this.keywordRegistry = await loadKeywordRegistry(this.kbRoot);

    // Build a lookup from wiki_slug → PaperEntry for matching source files
    const slugToPaper = new Map<string, PaperEntry>();
    if (this.masterIndex?.papers) {
      for (const paper of this.masterIndex.papers) {
        slugToPaper.set(paper.wiki_slug, paper);
      }
    }

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
          const { type, title, body, authors, year } = parseMd(raw);
          const slug = file.slice(0, -3); // strip .md
          const docId = `${subdir}/${slug}`;
          const docType = type !== "unknown" ? type : (DIR_TO_TYPE[subdir] ?? subdir);

          // Enrich source metadata from master_index.yaml if available
          let enrichedAuthors = authors;
          let enrichedYear = year;
          if (subdir === "sources" && slugToPaper.has(slug)) {
            const paper = slugToPaper.get(slug)!;
            if (enrichedAuthors.length === 0) enrichedAuthors = paper.authors;
            if (enrichedYear === undefined) enrichedYear = paper.year;
          }

          insertDoc.run(docId, docType, title, cleanBody(body));
          insertMeta.run(docId, filePath, docType, title, JSON.stringify(enrichedAuthors), enrichedYear ?? 0);
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
      insertMeta.run("overview", overviewPath, "overview", title || "Project Overview", "[]", 0);
      count++;
    }

    // Also index wiki/log.md for research activity context
    const logPath = join(wikiDir, "log.md");
    if (existsSync(logPath)) {
      const raw = await readFile(logPath, "utf8");
      const { type, title, body } = parseMd(raw);
      insertDoc.run("log", type || "log", title || "Research Log", cleanBody(body));
      insertMeta.run("log", logPath, "log", title || "Research Log", "[]", 0);
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
    console.log(`[KB] Indexed ${count} pages (master_index: ${this.masterIndex ? this.masterIndex.papers.length + ' papers' : 'not found'})`);
  }

  search(query: string, limit = 5): KBSearchResult[] {
    if (!this.indexed) return [];
    const ftsQuery = safeFtsQuery(query);
    if (ftsQuery === '""') return [];
    try {
      const rows = this.db.query(`
        SELECT
          m.doc_id    AS docId,
          m.doc_type  AS docType,
          m.title     AS title,
          m.file_path AS filePath,
          snippet(docs, 3, '', '', '…', 30) AS excerpt,
          bm25(docs)  AS score,
          m.authors   AS authorsJson,
          m.year      AS year
        FROM docs
        JOIN doc_meta m ON docs.doc_id = m.doc_id
        WHERE docs MATCH ?
        ORDER BY bm25(docs)
        LIMIT ?
      `).all(ftsQuery, limit) as Array<{ docId: string; docType: string; title: string; filePath: string; excerpt: string; score: number; authorsJson: string; year: number }>;

      return rows.map(row => ({
        docId: row.docId,
        docType: row.docType,
        title: row.title,
        filePath: row.filePath,
        excerpt: row.excerpt,
        score: Math.abs(row.score),
        authors: safeJsonParse(row.authorsJson),
        year: row.year || undefined,
      }));
    } catch (err) {
      console.warn("[KB] FTS5 search error:", err);
      return [];
    }
  }

  /** Keyword search: given a keyword, return matching paper slugs from the keyword registry */
  searchByKeyword(keyword: string): string[] {
    if (!this.keywordRegistry) return [];
    const entry = this.keywordRegistry[keyword];
    if (entry) return entry.papers;
    // Case-insensitive fallback
    const lower = keyword.toLowerCase();
    for (const [kw, data] of Object.entries(this.keywordRegistry)) {
      if (kw.toLowerCase() === lower) return data.papers;
    }
    return [];
  }

  /** Get enriched metadata for a source by its wiki slug */
  getSourceMeta(slug: string): PaperEntry | null {
    if (!this.masterIndex) return null;
    return this.masterIndex.papers.find(p => p.wiki_slug === slug) ?? null;
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

function safeJsonParse(val: string): string[] {
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
