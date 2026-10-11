import type { OllamaMessage } from "../../../shared/rpc-types";
import { AI_WRITING_STYLE } from "../../../shared/ai-writing-style";
import { COLLAB_THREADS_MAP } from "../../../shared/collab/protocol";
import { createThread, readThreads, type ThreadMeta } from "../../../shared/collab/threads";
import { SCHOLARPEN_AI } from "../../../shared/collab/personas";
import {
  REVIEW_MAP,
  REVIEW_CATEGORIES,
  canonicalFindingFingerprint,
  enabledReviewCategories,
  isReviewSeverity,
  normalizeReviewCategory,
  type ReviewCategory,
  reviewSettingsOf,
  SEVERITY_RANK,
  type ReviewFinding,
  type ReviewSettings,
  type ReviewProgress,
} from "../../../shared/collab/review";
import { AI_META_ORIGIN, type Attachment, type CollabAgent } from "./agent";
import {
  anchorThread,
  blockContent,
  findBlock,
  hasInlineContent,
  readDoc,
  readableText,
  sectionOf,
  type BlockRef,
} from "./doc-model";
import { clip } from "./prompts";
import { RESOLVED_REVIEW_BLOCKS_MAP } from "./resolved-review";
import { StaleClaimSweeper } from "./stale-claims";
import { DISMISSED_FINDINGS_MAP, purgeResolvedThreads } from "./resolved-purge";
import { checkTerminology, glossaryGuidance, type Glossary } from "../../../shared/glossary";

export interface ReviewerDeps {
  complete(messages: OllamaMessage[], signal: AbortSignal): Promise<string>;
  /** Citekeys in the project's bibliography, or null when it cannot be read. */
  citekeys(projectPath: string): Promise<Set<string> | null>;
  /** The project glossary; terminology checks and review prompts follow it. */
  glossary?(projectPath: string): Promise<Glossary>;
  now?: () => number;
  /** Minimum gap between automatic reviews of one document. */
  autoIntervalMs?: number;
  maxAutoPerHour?: number;
  tickMs?: number;
}

// Limit each model response, not the number of comments a document may receive.
const MAX_FINDINGS_PER_BATCH = 10;
const MAX_PARAGRAPHS_PER_BATCH = 8;
const MAX_BATCH_CHARS = 8_000;
const REVIEW_VERSION = 2;

interface SectionReview {
  hash: string;
  at: number;
  reason: "manual" | "auto";
  added: number;
  version?: number;
  settings?: string;
  /** Per-paragraph snapshots let resolution remove a target without restarting its section. */
  paragraphs?: Record<string, string>;
  heading?: string;
}

function settingsFingerprint(settings: ReviewSettings) {
  return JSON.stringify([settings.minSeverity, [...settings.muted].sort()]);
}

/** Stricter preferences must not trigger another wave of comments on unchanged text. */
function previousReviewCoversSettings(fingerprint: string | undefined, settings: ReviewSettings) {
  if (!fingerprint) return false;
  try {
    const previous: unknown = JSON.parse(fingerprint);
    if (!Array.isArray(previous) || !isReviewSeverity(previous[0]) || !Array.isArray(previous[1])) return false;
    return SEVERITY_RANK[previous[0]] <= SEVERITY_RANK[settings.minSeverity] &&
      previous[1].every(category => settings.muted.includes(category));
  } catch {
    return false;
  }
}

function proseOf(section: Section) {
  return section.blocks.flatMap(flatten)
    .filter((block) => hasInlineContent(block) && block.node.firstChild?.type.name !== "heading");
}

/** Keep every paragraph, including the tail of long sections. Never truncate the review target. */
function paragraphBatches(prose: BlockRef[], doc: ReturnType<typeof readDoc>) {
  const batches: BlockRef[][] = [];
  let batch: BlockRef[] = [];
  let chars = 0;
  for (const block of prose) {
    const size = readableText(doc, blockContent(block).from, blockContent(block).to).length;
    if (batch.length && (batch.length >= MAX_PARAGRAPHS_PER_BATCH || chars + size > MAX_BATCH_CHARS)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(block);
    chars += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

type Section = NonNullable<ReturnType<typeof sectionOf>>;

function sectionKey(section: Section) {
  return section.heading?.id ?? section.blocks[0]?.id ?? "start";
}

function sectionTitle(section: Section) {
  return section.heading?.node.firstChild?.textContent.trim() || "Opening section";
}

function sectionFingerprint(doc: ReturnType<typeof readDoc>, section: Section) {
  return section.blocks.map((block) => readableText(doc, block.pos, block.pos + block.node.nodeSize)).join("\n");
}

function paragraphFingerprint(doc: ReturnType<typeof readDoc>, block: BlockRef) {
  const { from, to } = blockContent(block);
  return hashText(readableText(doc, from, to));
}

function normalize(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Document range of `quote` inside a block's text, ignoring whitespace differences. */
export function locateQuote(block: BlockRef, quote: string) {
  const content = blockContent(block);
  const chars: number[] = [];
  let text = "";
  content.node.descendants((node, pos) => {
    if (!node.isText) return true;
    for (let i = 0; i < node.text!.length; i++) {
      chars.push(content.from + pos + i);
      text += node.text![i];
    }
    return true;
  });
  const wanted = quote.trim();
  if (!wanted) return null;
  let at = text.indexOf(wanted);
  let length = wanted.length;
  if (at < 0) {
    // Retry on a whitespace-collapsed copy, mapping indexes back.
    const map: number[] = [];
    let collapsed = "";
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i]) && /\s/.test(collapsed.at(-1) ?? "")) continue;
      map.push(i);
      collapsed += /\s/.test(text[i]) ? " " : text[i];
    }
    const target = wanted.replace(/\s+/g, " ");
    const index = collapsed.indexOf(target);
    if (index < 0) return null;
    at = map[index];
    length = map[index + target.length - 1] - at + 1;
  }
  return { from: chars[at], to: chars[at + length - 1] + 1 };
}

function buildReviewMessages(title: string, paragraphs: string[], context: string, allowed: ReviewCategory[], settings: ReviewSettings, glossary = ""): OllamaMessage[] {
  const system =
    `You are ${SCHOLARPEN_AI.name}, reviewing a section of an academic manuscript together with its author. ` +
    "Protect the author's attention: report concrete problems, not opportunities to improve an already defensible passage. " +
    `The minimum severity is ${settings.minSeverity}. Omit findings below this threshold; never inflate their severity to pass it. ` +
    "Severity rubric: high = a clearly demonstrated problem that materially changes a central claim, conclusion, or the validity of the analysis, " +
    "such as a direct contradiction, an incorrect calculation, reversed chronology or causality, or a central inference incompatible with the stated evidence or design. " +
    "Medium = a substantive but local ambiguity, missing explanation, or evidential qualification that does not invalidate the main argument. " +
    "Low = optional elaboration or minor clarification. " +
    "For a high-severity finding, identify the specific evidence in the supplied text and explain the material consequence if it remains unfixed. " +
    "If you cannot establish both, omit the finding. When uncertain whether a problem is serious, omit it. " +
    "Do not request more definitions, background, literature, caveats, alternative explanations, or citations merely because they would be useful. " +
    "A term not defined in this paragraph, a citation not repeated locally, or an unfamiliar theoretical interpretation is not by itself a serious error. " +
    "Respect the manuscript's genre and argumentative purpose; do not impose empirical-study reporting requirements on a conceptual or historical essay. " +
    "Check the supplied surrounding context before alleging an omission or contradiction. Context is partial: do not infer that something is absent from the whole manuscript. " +
    "Without the cited source text, do not assert that a source fails to support a claim based only on its title, date, or your memory. " +
    "Read every supplied paragraph, including the last one. Do not focus only on the opening. " +
    "Avoid cosmetic wording preferences and trivial grammar corrections. " +
    "Do not invent references. Return an empty findings array when no problem meets the threshold; zero findings is a successful review. " +
    "Combine observations about the same underlying problem into one comment rather than repeating it under several categories. " +
    `Only report these enabled categories: ${allowed.join(", ")}. Do not invent categories or rename disabled issues to an enabled type. ` +
    REVIEW_CATEGORIES.filter(category => allowed.includes(category.id)).map(category => `${category.id}: ${category.description}`).join("\n") + "\n" +
    "Write each comment in the language of the manuscript, in one or two sentences, and say what to check or change. " +
    (glossary ? `${glossary}\nA term used against this glossary is a consistency finding; undefined abbreviations are checked separately, do not report them.\n` : "") +
    AI_WRITING_STYLE + "\n\n" +
    "Return JSON only, in this shape:\n" +
    `{"findings":[{"paragraph":1,"quote":"exact words copied from that paragraph","category":"${allowed.join("|")}","severity":"low|medium|high","comment":"..."}]}\n` +
    `Report at most ${MAX_FINDINGS_PER_BATCH} findings, most important first. This is a ceiling, never a quota; most passages should need no comment. The quote must be copied exactly from the paragraph and be at most 25 words.`;
  const user =
    `<section title="${title.replace(/"/g, "'")}">\n` +
    paragraphs.map((text, index) => `<paragraph n="${index + 1}">\n${text}\n</paragraph>`).join("\n") +
    "\n</section>\n\n" +
    `<rest_of_manuscript reference_only="true">\n${context}\n</rest_of_manuscript>`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

function parseFindings(response: string, paragraphCount: number): ReviewFinding[] {
  const cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, "");
  const json = cleaned.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error("The reviewer did not return JSON.");
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || !("findings" in parsed) || !Array.isArray(parsed.findings)) {
    throw new Error("The reviewer did not return a findings array.");
  }
  const findings: ReviewFinding[] = [];
  for (const raw of parsed.findings) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const category = normalizeReviewCategory(item.category);
    if (!category) continue;
    const paragraph = Number(item.paragraph);
    if (!isReviewSeverity(item.severity)) continue;
    const severity = item.severity;
    if (!Number.isInteger(paragraph) || paragraph < 1 || paragraph > paragraphCount) continue;
    if (typeof item.quote !== "string" || typeof item.comment !== "string" || !item.comment.trim()) continue;
    findings.push({
      paragraph: paragraph - 1,
      quote: item.quote,
      category,
      severity,
      comment: item.comment.trim(),
    });
  }
  return findings;
}

/**
 * Reviews the whole open manuscript independently of human edits. Coverage and
 * the next position survive reopening; changed sections are revisited fairly.
 */
export class Reviewer {
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval> | null;
  private readonly lastAuto = new Map<string, number[]>();
  private lastDocument: string | null = null;
  private readonly sweeper: StaleClaimSweeper;

  constructor(private readonly agent: CollabAgent, private readonly deps: ReviewerDeps) {
    this.now = deps.now ?? Date.now;
    this.sweeper = new StaleClaimSweeper(this.now);
    this.timer = deps.tickMs === 0 ? null : setInterval(() => this.tick(), deps.tickMs ?? 10_000);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Queues a review of the section that contains the block. */
  reviewSection(docKey: string, blockId: string, reason: "manual" | "auto" = "manual") {
    const attachment = this.agent.attachmentFor(docKey);
    if (!attachment) throw new Error("This document is not open.");
    const section = sectionOf(readDoc(attachment.session), blockId);
    if (!section) throw new Error("Could not find that section.");
    const key = sectionKey(section);
    return this.agent.enqueue(attachment, {
      kind: "review",
      label: sectionTitle(section),
      blockId: key,
      agent: SCHOLARPEN_AI.id,
    }, (_job, att, signal) => this.runReview(att, key, reason, signal));
  }

  /** Round-robin across documents and sections; no edit or cursor prerequisite. */
  tick() {
    const attachments = this.agent.attachmentList();
    // Independent of automatic review: claims on passages the author rewrote no longer apply.
    // Then delete what is settled, keeping only the small ledgers review needs.
    for (const { session } of attachments) {
      this.sweeper.sweep(session, AI_META_ORIGIN);
      purgeResolvedThreads(session, AI_META_ORIGIN, this.now());
    }
    const docStart = attachments.findIndex((att) => att.session.docKey === this.lastDocument) + 1;
    for (let offset = 0; offset < attachments.length; offset++) {
      const attachment = attachments[(docStart + offset) % attachments.length];
      const { session } = attachment;
      const map = session.ydoc.getMap(REVIEW_MAP);
      const settings = reviewSettingsOf(map);
      const doc = readDoc(session);
      const reviewed = (map.get("sections") as Record<string, SectionReview> | undefined) ?? {};
      const resolved = session.ydoc.getMap<boolean>(RESOLVED_REVIEW_BLOCKS_MAP);
      const seen = new Set<string>();
      const sections: Array<{ key: string; current: boolean }> = [];
      for (const block of iterateTop(doc)) {
        const section = sectionOf(doc, block.id);
        if (!section) continue;
        const key = sectionKey(section);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!proseOf(section).length) continue;
        const eligible = proseOf(section).filter(block => !resolved.has(block.id));
        const previous = reviewed[key];
        sections.push({ key, current: !eligible.length || (previous?.version === REVIEW_VERSION &&
          previousReviewCoversSettings(previous.settings, settings) && (previous.paragraphs
            ? previous.heading === sectionTitle(section) && eligible.every(block =>
              previous.paragraphs![block.id] === paragraphFingerprint(doc, block))
            : previous.hash === hashText(sectionFingerprint(doc, section)))) });
      }
      const progress: ReviewProgress = {
        reviewedSections: sections.filter((section) => section.current).length,
        totalSections: sections.length,
      };
      const previousProgress = map.get("progress") as ReviewProgress | undefined;
      if (previousProgress?.reviewedSections !== progress.reviewedSections || previousProgress?.totalSections !== progress.totalSections) {
        session.ydoc.transact(() => map.set("progress", progress), AI_META_ORIGIN);
      }
      if (!settings.autoReview || !enabledReviewCategories(settings).length || this.agent.isPaused() || this.agent.isBusy(session.docKey)) continue;
      const history = (this.lastAuto.get(session.docKey) ?? []).filter((at) => this.now() - at < 3_600_000);
      if (history.length >= (this.deps.maxAutoPerHour ?? Infinity)) continue;
      if (history.length && this.now() - history[history.length - 1] < (this.deps.autoIntervalMs ?? 15_000)) continue;

      const start = sections.findIndex((section) => section.key === map.get("cursor")) + 1;
      for (let index = 0; index < sections.length; index++) {
        const section = sections[(start + index) % sections.length];
        if (section.current) continue;
        // Save before starting, so failures/restarts cannot trap us at the beginning.
        session.ydoc.transact(() => map.set("cursor", section.key), AI_META_ORIGIN);
        history.push(this.now());
        this.lastAuto.set(session.docKey, history);
        this.lastDocument = session.docKey;
        this.reviewSection(session.docKey, section.key, "auto");
        return;
      }
    }
  }

  private async runReview(attachment: Attachment, key: string, reason: "manual" | "auto", signal: AbortSignal) {
    const { session } = attachment;
    const reviewMap = session.ydoc.getMap(REVIEW_MAP);
    const settings = reviewSettingsOf(reviewMap);
    const allowed = enabledReviewCategories(settings);
    if (!allowed.length) return;
    let doc = readDoc(session);
    const section = sectionOf(doc, key);
    if (!section) return;
    const resolved = session.ydoc.getMap<boolean>(RESOLVED_REVIEW_BLOCKS_MAP);
    const eligible = (block: BlockRef) => reason === "manual" || !resolved.has(block.id);
    const originalHash = hashText(sectionFingerprint(doc, section));
    const prose = proseOf(section).filter(eligible);
    if (!prose.length) return;
    const originalText = new Map(prose.map((block) => [block.id,
      readableText(doc, blockContent(block).from, blockContent(block).to)]));
    // Rule findings come from deterministic checks the author configured, so no severity threshold hides them.
    const findings: Array<ReviewFinding & { blockId: string; rule?: boolean }> = [];
    const glossary = await this.deps.glossary?.(session.projectPath).catch(() => null) ?? null;
    if (glossary && (allowed.includes("definition") || allowed.includes("consistency"))) {
      // First use is a whole-document property; only this section's paragraphs get comments.
      const inSection = new Set(prose.map(block => block.id));
      const all = [...iterateTop(doc)].flatMap(flatten).filter(block => hasInlineContent(block) && block.node.firstChild?.type.name !== "heading");
      for (const finding of checkTerminology(all.map(block => ({ blockId: block.id,
        text: readableText(doc, blockContent(block).from, blockContent(block).to) })), glossary)) {
        const category = finding.kind === "abbreviation" ? "definition" : "consistency";
        if (!inSection.has(finding.blockId) || !allowed.includes(category)) continue;
        findings.push({ blockId: finding.blockId, paragraph: -1, quote: finding.quote, category, severity: "medium", comment: finding.comment, rule: true });
      }
    }

    // Deterministic check first: citations whose key is not in the bibliography.
    const keys = allowed.includes("citation") ? await this.deps.citekeys(session.projectPath) : null;
    if (keys) {
      for (const block of prose) {
        if (!eligible(block)) continue;
        blockContent(block).node.descendants((node) => {
          if (node.type.name !== "citation") return true;
          const citekey = String(node.attrs.citekey ?? "");
          if (citekey && !keys.has(citekey)) {
            findings.push({
              blockId: block.id, paragraph: -1, quote: "", category: "citation", severity: "high",
              comment: `@${citekey} is not in references.bib. Add the entry or correct the citation key.`,
            });
          }
          return true;
        });
      }
    }

    const batches = paragraphBatches(prose, doc);
    for (const plannedBatch of batches) {
      if (signal.aborted) throw new Error("Cancelled");
      if (reason === "auto" && !reviewSettingsOf(reviewMap).autoReview) return;
      // Resolution may arrive while an earlier batch or bibliography lookup runs.
      const batch = plannedBatch.filter(eligible);
      if (!batch.length) continue;
      const paragraphs = batch.map((block) => originalText.get(block.id)!);
      const first = batch[0];
      const last = batch[batch.length - 1];
      const contextBlocks = [...iterateTop(doc)].flatMap(flatten)
        .filter(block => hasInlineContent(block) && eligible(block));
      const contextText = (blocks: BlockRef[]) => blocks.map(block => {
        const { from, to } = blockContent(block);
        return readableText(doc, from, to);
      }).join("\n");
      const context = clip(contextText(contextBlocks.filter(block => block.pos < first.pos)), 3000, "end") +
        "\n[…reviewed paragraphs…]\n" +
        clip(contextText(contextBlocks.filter(block => block.pos > last.pos)), 2000, "start");
      attachment.presence.claim(first.id, "reviewing");
      const response = await this.deps.complete(
        buildReviewMessages(sectionTitle(section), paragraphs, context, allowed, settings, glossary ? glossaryGuidance(glossary) : ""), signal);
      if (signal.aborted) throw new Error("Cancelled");
      for (const finding of parseFindings(response, batch.length)) {
        findings.push({ ...finding, blockId: batch[finding.paragraph].id });
      }
    }

    // No per-section or per-run posting cap: bibliography checks cannot displace
    // substantive findings. Keep explicit preferences and exact deduplication.
    if (signal.aborted) throw new Error("Cancelled");
    const currentSettings = reviewSettingsOf(reviewMap);
    if (reason === "auto" && !currentSettings.autoReview) return;
    const threads = session.ydoc.getMap(COLLAB_THREADS_MAP);
    const existing = readThreads(threads);
    // Resolved threads are deleted; their fingerprints stay in this ledger.
    const dismissed = session.ydoc.getMap<boolean>(DISMISSED_FINDINGS_MAP);
    let added = 0;

    doc = readDoc(session);
    for (const finding of findings) {
      // Discard even a different issue if the author resolved this paragraph in flight.
      if (reason === "auto" && resolved.has(finding.blockId)) continue;
      if (!finding.rule && SEVERITY_RANK[finding.severity] < SEVERITY_RANK[currentSettings.minSeverity]) continue;
      if (currentSettings.muted.includes(finding.category)) continue;
      const fingerprint = `${SCHOLARPEN_AI.id}:${finding.blockId}:${finding.category}:${normalize(finding.quote || finding.comment)}`;
      // Never raise a finding twice, including one the author already resolved.
      const duplicate = dismissed.has(fingerprint) || existing.some((thread) => canonicalFindingFingerprint(thread.meta) === fingerprint ||
        (!thread.resolved && thread.meta.blockId === finding.blockId &&
          normalize(thread.comments[0]?.text ?? "") === normalize(finding.comment)));
      if (duplicate) continue;
      const block = findBlock(doc, finding.blockId);
      if (!block) continue;
      // Do not attach a response to words that changed while the model was reading.
      if (readableText(doc, blockContent(block).from, blockContent(block).to) !== originalText.get(block.id)) continue;
      const range = (finding.quote && locateQuote(block, finding.quote)) || blockContent(block);
      const meta: ThreadMeta = {
        agent: SCHOLARPEN_AI.id, category: finding.category, severity: finding.severity,
        blockId: finding.blockId, assignee: "me", status: "open", fingerprint,
        anchorText: readableText(doc, range.from, range.to),
      };
      session.ydoc.transact(() => {
        const threadId = createThread(threads, SCHOLARPEN_AI.userId, finding.comment, meta);
        anchorThread(session, block.id, threadId, AI_META_ORIGIN, range.from, range.to);
      }, AI_META_ORIGIN);
      doc = readDoc(session);
      existing.push(...readThreads(threads).filter((thread) => thread.meta.fingerprint === fingerprint));
      added++;
    }

    session.ydoc.transact(() => {
      const sections = { ...((reviewMap.get("sections") as Record<string, unknown> | undefined) ?? {}) };
      // Record the version we actually read, not a newer edit made during inference.
      sections[key] = { hash: originalHash, at: this.now(), reason, added,
        version: REVIEW_VERSION, settings: settingsFingerprint(settings),
        heading: sectionTitle(section),
        paragraphs: Object.fromEntries([...originalText].map(([id, text]) => [id, hashText(text)])),
      } satisfies SectionReview;
      reviewMap.set("sections", sections);
    }, AI_META_ORIGIN);
  }
}

function flatten(block: BlockRef): BlockRef[] {
  const out: BlockRef[] = [block];
  block.node.descendants((node, pos) => {
    if (node.type.name === "blockContainer") out.push({ id: node.attrs.id, pos: block.pos + 1 + pos, node });
    return true;
  });
  return out;
}

function* iterateTop(doc: ReturnType<typeof readDoc>) {
  const group = doc.firstChild;
  if (!group) return;
  let offset = 1;
  for (let i = 0; i < group.childCount; i++) {
    const node = group.child(i);
    if (node.type.name === "blockContainer") yield { id: node.attrs.id as string, pos: offset, node };
    offset += node.nodeSize;
  }
}

function hashText(text: string) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return `${text.length}:${hash >>> 0}`;
}
