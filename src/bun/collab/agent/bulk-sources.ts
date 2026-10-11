import { relative, sep } from "path";
import type { CitationMetadata, FileNode } from "../../../shared/rpc-types";
import { normalizeDoi, parseBibtexEntries, type BibtexEntry } from "../../../shared/bibtex-utils";
import type { CollabSession } from "../registry";

/** A project file other than the manuscript under revision, as plain text. */
export interface ProjectText { path: string; text: string }

/** A real, DOI-bearing work proposed as evidence for a passage. */
export interface CitationCandidate {
  doi: string;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  abstract?: string;
  /** Where it was found: the project's own article digests or a scholarly index. */
  source: string;
}

/** Everything a coordinated revision may read or write outside the open document. */
export interface BulkSources {
  /** Other manuscripts (saved `.scholarpen.json` snapshots) and drafts of the project. Read-only. */
  documents(signal: AbortSignal): Promise<ProjectText[]>;
  loadBibtex(): Promise<string>;
  /** Writes references.bib (with a backup); refuses when the file is no longer `expected`. */
  saveBibtex(bibtex: string, expected: string): Promise<void>;
  /** CrossRef metadata with a generated BibTeX entry. */
  resolveDOI(doi: string, signal: AbortSignal): Promise<CitationMetadata>;
  /** Candidate works for a passage that needs a source. */
  findCitations(passage: string, signal: AbortSignal): Promise<CitationCandidate[]>;
}

const NOTE_EXTENSIONS = /\.(md|qmd|txt)$/i;
const MAX_PROJECT_FILES = 80;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function inlineText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(item => {
    if (!record(item)) return "";
    const props = record(item.props) ? item.props : {};
    switch (item.type) {
      case "text": return typeof item.text === "string" ? item.text : "";
      case "citation": return `[@${props.citekey ?? ""}${props.locator ? `, ${props.locator}` : ""}]`;
      case "crossReference": return `@${props.label ?? ""}`;
      case "inlineMath": return `$${props.formula ?? ""}$`;
      case "footnote": return `[^${props.index ?? ""}]`;
      default: return inlineText(item.content);
    }
  }).join("");
}

/** Readable text of a saved BlockNote document; citations keep their `[@key]` form. */
export function blockNoteText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const lines: string[] = [];
  for (const block of blocks) {
    if (!record(block)) continue;
    const props = record(block.props) ? block.props : {};
    let text = "";
    if (Array.isArray(block.content)) text = inlineText(block.content);
    else if (record(block.content) && Array.isArray(block.content.rows)) {
      text = block.content.rows.map(row => record(row) && Array.isArray(row.cells)
        ? row.cells.map(cell => inlineText(record(cell) ? cell.content : cell)).join(" | ") : "").join("\n");
    }
    if (block.type === "heading") text = `${"#".repeat(Number(props.level) || 1)} ${text}`;
    if (block.type === "math" && props.formula) text = `$$${props.formula}$$`;
    if (block.type === "figure" && props.caption) text = `Figure: ${props.caption}`;
    if (text.trim()) lines.push(text);
    const children = blockNoteText(block.children);
    if (children) lines.push(children);
  }
  return lines.join("\n\n");
}

/**
 * Shares a character budget fairly: short files are kept whole and long ones
 * keep their beginning and end. Files that would get only a sliver are listed
 * as omitted so the model never mistakes an excerpt for the whole project.
 */
export function fitProjectTexts(files: ProjectText[], budget: number) {
  const caps = new Map<string, number>();
  let left = Math.max(0, budget);
  const byLength = [...files].sort((a, b) => a.text.length - b.text.length);
  byLength.forEach((file, index) => {
    const take = Math.min(file.text.length, Math.floor(left / (byLength.length - index)));
    caps.set(file.path, take);
    left -= take;
  });
  return files.map(file => {
    const cap = caps.get(file.path) ?? 0;
    if (cap >= file.text.length) return { path: file.path, text: file.text, truncated: false };
    if (cap < 1_000) return { path: file.path, text: "", truncated: true, omitted: true };
    const head = file.text.slice(0, Math.floor(cap * 0.7));
    const tail = file.text.slice(-Math.floor(cap * 0.25));
    return { path: file.path, text: `${head}\n\n[...excerpt; middle omitted...]\n\n${tail}`, truncated: true };
  });
}

function strip(value: string | undefined) {
  return (value ?? "").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

/** One line per library entry: `key: Authors (year). Title. Venue. doi:…`. */
export function libraryLine(entry: BibtexEntry) {
  const authors = strip(entry.fields.author).split(/\s+and\s+/i).filter(Boolean);
  const names = authors.length > 3 ? `${authors.slice(0, 3).join("; ")}; et al.` : authors.join("; ");
  const venue = strip(entry.fields.journal || entry.fields.booktitle || entry.fields.publisher);
  const doi = normalizeDoi(entry.fields.doi);
  return `${entry.citekey}: ${names || "Unknown author"} (${strip(entry.fields.year) || "n.d."}). ${strip(entry.fields.title) || "Untitled"}.` +
    `${venue ? ` ${venue}.` : ""}${doi ? ` doi:${doi}` : ""}`;
}

function words(text: string) {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []));
}

/**
 * The library the model may cite from. When references.bib is too large for
 * the budget, entries already cited in the project come first, then entries
 * whose titles share the most words with the comments and passages at hand.
 */
export function fitLibrary(bibtex: string, budget: number, cited: Set<string>, relevantText: string) {
  const entries = parseBibtexEntries(bibtex).entries;
  const lines = entries.map(entry => ({ entry, line: libraryLine(entry) }));
  const total = lines.reduce((sum, item) => sum + item.line.length + 4, 0);
  if (total <= budget) return { entries: lines.map(item => item.line), total: entries.length, truncated: false };
  const topic = words(relevantText);
  const score = (entry: BibtexEntry) => (cited.has(entry.citekey) ? 1_000 : 0) +
    [...words(`${entry.fields.title ?? ""} ${entry.fields.keywords ?? ""} ${entry.fields.abstract ?? ""}`)].filter(word => topic.has(word)).length;
  const chosen: string[] = [];
  let used = 0;
  for (const item of [...lines].sort((a, b) => score(b.entry) - score(a.entry))) {
    if (used + item.line.length + 4 > budget) continue;
    chosen.push(item.line);
    used += item.line.length + 4;
  }
  return { entries: chosen, total: entries.length, truncated: true };
}

function flatten(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap(node => node.isDirectory ? flatten(node.children ?? []) : [node]);
}

/** The default sources for a session: the project's files on disk, CrossRef and OpenAlex. */
export async function projectBulkSources(session: CollabSession): Promise<BulkSources> {
  const [{ fileSystem }, { citationClient }, { getProjectSourceIndex }] = await Promise.all([
    import("../../fs/manager"), import("../../citation/client"), import("../../project-sources"),
  ]);
  const { projectPath } = session;
  const projectRelative = (path: string) => relative(projectPath, path).split(sep).join("/");
  const abortable = <T>(promise: Promise<T>, signal: AbortSignal) => new Promise<T>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => reject(signal.reason ?? new Error("Cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
  return {
    async documents(signal) {
      const files = flatten(await fileSystem.listProjectFiles(projectPath, 0, Number.POSITIVE_INFINITY))
        .map(file => ({ file, path: projectRelative(file.path) }))
        .filter(({ path }) => path.startsWith("documents/")
          ? path.endsWith(".scholarpen.json") && path !== `documents/${session.filename}`
          : path.startsWith("drafts/") && NOTE_EXTENSIONS.test(path))
        .sort((a, b) => a.path.localeCompare(b.path))
        .slice(0, MAX_PROJECT_FILES);
      const texts: ProjectText[] = [];
      for (const { file, path } of files) {
        signal.throwIfAborted();
        try {
          const raw = await fileSystem.readTextFile(file.path);
          const text = path.endsWith(".scholarpen.json") ? blockNoteText(JSON.parse(raw)) : raw;
          if (text.trim()) texts.push({ path, text });
        } catch (error) {
          texts.push({ path, text: `[Could not be read: ${error instanceof Error ? error.message : String(error)}]` });
        }
      }
      return texts;
    },
    loadBibtex: () => fileSystem.loadBibtex(projectPath),
    async saveBibtex(bibtex, expected) {
      await fileSystem.saveBibliographyMaintenance(projectPath, bibtex, "ai-citations", expected);
    },
    resolveDOI: (doi, signal) => abortable(citationClient.resolveDOI(doi), signal),
    async findCitations(passage, signal) {
      const settings = await fileSystem.getSettings();
      const [own, external] = await Promise.allSettled([
        getProjectSourceIndex(projectPath).search(passage, 4),
        citationClient.findSupportingCitations(passage, 4, settings.openAlexApiKey || undefined, signal),
      ]);
      const candidates: CitationCandidate[] = [];
      if (own.status === "fulfilled") for (const hit of own.value) {
        if (hit.doi) candidates.push({ doi: hit.doi, title: hit.title, authors: hit.authors, year: hit.year,
          abstract: hit.content.slice(0, 800), source: `project article digest ${hit.digestRelpath}` });
      }
      if (external.status === "fulfilled") for (const hit of external.value) {
        candidates.push({ doi: hit.doi, title: hit.title, authors: hit.authors, year: hit.year || undefined,
          venue: hit.journal, abstract: hit.abstract?.slice(0, 800), source: hit.sourceDatabase });
      }
      return candidates;
    },
  };
}
