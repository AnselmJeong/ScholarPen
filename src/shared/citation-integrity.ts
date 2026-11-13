import type {
  BibliographyIntegrityNotice,
  BibliographyMaintenanceResult,
} from "./rpc-types";

/** A Crossref `update-to` / `updated-by` relation. */
export interface CrossrefUpdateRelation {
  DOI?: string;
  type?: string;
  label?: string;
  updated?: { "date-parts"?: number[][] };
}

const RETRACTION_TYPES = new Set(["retraction", "partial_retraction", "removal", "withdrawal"]);
const CONCERN_TYPES = new Set(["expression_of_concern"]);

function noticeKind(type: string | undefined): BibliographyIntegrityNotice["kind"] | null {
  const normalized = (type ?? "").toLocaleLowerCase().replace(/[\s-]+/g, "_");
  if (RETRACTION_TYPES.has(normalized)) return "retracted";
  if (CONCERN_TYPES.has(normalized)) return "expression_of_concern";
  return null;
}

function relationDate(relation: CrossrefUpdateRelation): string | undefined {
  const parts = relation.updated?.["date-parts"]?.[0];
  if (!parts?.length) return undefined;
  return parts.map((part, index) => index === 0 ? String(part) : String(part).padStart(2, "0")).join("-");
}

/**
 * Notices attached to a cited work through Crossref's `updated-by` relation.
 * Corrections and errata are not integrity problems and are ignored.
 */
export function integrityNoticesFromCrossref(updatedBy: CrossrefUpdateRelation[] | undefined): BibliographyIntegrityNotice[] {
  const notices = new Map<string, BibliographyIntegrityNotice>();
  for (const relation of updatedBy ?? []) {
    const kind = noticeKind(relation.type);
    if (!kind) continue;
    const noticeDoi = relation.DOI?.trim().toLocaleLowerCase() || undefined;
    const key = `${kind}:${noticeDoi ?? ""}`;
    if (notices.has(key)) continue;
    notices.set(key, { kind, source: "crossref", noticeDoi, date: relationDate(relation) });
  }
  // Retractions outrank expressions of concern.
  return [...notices.values()].sort((left, right) =>
    Number(right.kind === "retracted") - Number(left.kind === "retracted"));
}

/** True when the record itself is an editorial notice (its `update-to` targets another work). */
export function isEditorialNoticeRecord(updateTo: CrossrefUpdateRelation[] | undefined): boolean {
  return (updateTo ?? []).some((relation) => noticeKind(relation.type) !== null);
}

// ── Vague attributions ────────────────────────────────────────────

const VAGUE_PATTERNS: RegExp[] = [
  /\b(?:a|one|some|many|several|recent|previous|prior)\s+(?:recent\s+)?stud(?:y|ies)\s+(?:has\s+|have\s+)?(?:found|showed|shown|suggested|suggests?|reported|demonstrated)\b/i,
  /\bstudies\s+(?:show|showed|have\s+shown|suggest|indicate)\b/i,
  /\bresearch\s+(?:has\s+)?(?:shown|shows|suggests|indicates|demonstrates)\b/i,
  /\b(?:it\s+)?has\s+been\s+(?:shown|reported|demonstrated)\s+that\b/i,
  /\bevidence\s+suggests\b/i,
  /\bexperts\s+(?:say|agree|believe)\b/i,
  /\baccording\s+to\s+(?:a\s+|recent\s+|previous\s+)?(?:study|studies|research)\b/i,
  /(?:한|일부|많은|여러|최근|기존|선행)\s*연구(?:들)?에\s*따르면/,
  /연구(?:들)?에\s*따르면/,
  /(?:많은|여러|일부|기존|선행)\s*연구(?:들)?(?:에서|은|는|이|가)\s*(?:보고|밝혀|보여|시사)/,
  /전문가들은/,
];

/** Inline citations as serialized by `documentParagraphTexts`, Pandoc keys, numeric and author-year forms. */
const CITATION_MARKER = /\[@[^\]]+\]|(?:^|[\s(;[])@[A-Za-z][\w:.-]*|\[\d+(?:\s*[-–,]\s*\d+)*\]|\([^()]*\b(?:1[89]|20)\d{2}[a-z]?\)/;

const MAX_EXCERPT = 240;

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?。])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
}

export function findVagueAttributions(text: string): { phrase: string; excerpt: string }[] {
  const found: { phrase: string; excerpt: string }[] = [];
  const seen = new Set<string>();
  for (const sentence of splitSentences(text)) {
    if (CITATION_MARKER.test(sentence)) continue;
    for (const pattern of VAGUE_PATTERNS) {
      const match = pattern.exec(sentence);
      if (!match) continue;
      const excerpt = sentence.length > MAX_EXCERPT ? `${sentence.slice(0, MAX_EXCERPT - 1)}…` : sentence;
      if (!seen.has(excerpt)) {
        seen.add(excerpt);
        found.push({ phrase: match[0].trim(), excerpt });
      }
      break;
    }
  }
  return found;
}

const PROSE_BLOCKS = new Set(["paragraph", "bulletListItem", "numberedListItem", "checkListItem", "quote", "abstract"]);

function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (!item || typeof item !== "object") return "";
    const node = item as { type?: unknown; text?: unknown; content?: unknown; props?: Record<string, unknown> };
    if (node.type === "text" && typeof node.text === "string") return node.text;
    if (node.type === "link") return inlineText(node.content);
    if (node.type === "citation") {
      const citekey = typeof node.props?.citekey === "string" ? node.props.citekey : "";
      return citekey ? `[@${citekey}]` : "";
    }
    return "";
  }).join("");
}

/** Prose paragraph texts of a BlockNote document; figures, math, code and tables are skipped. */
export function documentParagraphTexts(blocks: unknown): string[] {
  const texts: string[] = [];
  const walk = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const block of value) {
      if (!block || typeof block !== "object") continue;
      const node = block as { type?: unknown; content?: unknown; children?: unknown };
      if (typeof node.type === "string" && PROSE_BLOCKS.has(node.type)) {
        const text = inlineText(node.content).trim();
        if (text) texts.push(text);
      }
      walk(node.children);
    }
  };
  walk(blocks);
  return texts;
}

// ── Report ────────────────────────────────────────────────────────

export interface IntegritySummary {
  verified: number;
  needsReview: number;
  unverified: number;
  retracted: number;
  concern: number;
  missing: number;
  vague: number;
}

export function summarizeIntegrity(result: BibliographyMaintenanceResult): IntegritySummary {
  const notices = (kind: string) => result.validations
    .filter((item) => item.integrityNotices?.some((notice) => notice.kind === kind)).length;
  return {
    verified: result.validations.filter((item) => item.status === "valid" || (item.status === "changes" && item.suggestedFields)).length,
    needsReview: result.validations.filter((item) => item.status === "changes" && !item.suggestedFields).length,
    unverified: result.validations.filter((item) => item.status === "unverified" || item.status === "error" || item.status === "unsupported").length,
    retracted: notices("retracted"),
    concern: result.validations.filter((item) =>
      item.integrityNotices?.some((notice) => notice.kind === "expression_of_concern")
      && !item.integrityNotices.some((notice) => notice.kind === "retracted")).length,
    missing: result.missingCitekeys.length,
    vague: result.vagueAttributions?.length ?? 0,
  };
}

function csvCell(value: string | undefined): string {
  const text = value ?? "";
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_HEADER = ["section", "citekey", "status", "field", "current", "canonical", "notice", "source", "filename", "excerpt"];

/** RFC 4180 CSV with a UTF-8 BOM so spreadsheet apps read Korean text correctly. */
export function buildIntegrityReportCsv(result: BibliographyMaintenanceResult): string {
  const rows: (string | undefined)[][] = [CSV_HEADER];
  for (const validation of result.validations) {
    rows.push(["entry", validation.citekey, validation.status, "", "", "", "", "", "", validation.message]);
    for (const field of validation.fields) {
      if (field.status === "match") continue;
      rows.push(["field", validation.citekey, field.status, field.field, field.current, field.canonical, "", "", "", ""]);
    }
    for (const notice of validation.integrityNotices ?? []) {
      rows.push(["notice", validation.citekey, notice.kind, "", "", "", notice.noticeDoi, notice.source, "", notice.date]);
    }
    if (validation.isEditorialNotice) {
      rows.push(["notice", validation.citekey, "doi_is_notice", "doi", validation.doi, "", "", "crossref", "", ""]);
    }
  }
  for (const citekey of result.missingCitekeys) rows.push(["missing_citekey", citekey, "missing", "", "", "", "", "", "", ""]);
  for (const item of result.vagueAttributions ?? []) {
    rows.push(["vague_attribution", "", "unsourced", "", item.phrase, "", "", "", item.filename, item.excerpt]);
  }
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
