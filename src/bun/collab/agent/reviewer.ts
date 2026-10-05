import type { OllamaMessage } from "../../../shared/rpc-types";
import { COLLAB_THREADS_MAP } from "../../../shared/collab/protocol";
import { createThread, readThreads, type ThreadMeta } from "../../../shared/collab/threads";
import { SCHOLARPEN_AI, isAIUser } from "../../../shared/collab/personas";
import {
  REVIEW_MAP,
  reviewSettingsOf,
  SEVERITY_RANK,
  type ReviewFinding,
  type ReviewSeverity,
} from "../../../shared/collab/review";
import type { CollabSession } from "../registry";
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

export interface ReviewerDeps {
  complete(messages: OllamaMessage[], signal: AbortSignal): Promise<string>;
  /** Citekeys in the project's bibliography, or null when it cannot be read. */
  citekeys(projectPath: string): Promise<Set<string> | null>;
  now?: () => number;
  /** A section is reviewed automatically once the author has left it alone this long. */
  idleMs?: number;
  /** Minimum gap between automatic reviews of one document. */
  autoIntervalMs?: number;
  maxAutoPerHour?: number;
  tickMs?: number;
}

const MAX_OPEN_PER_SECTION = 3;
const MAX_NEW_PER_RUN = 3;

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

function buildReviewMessages(title: string, paragraphs: string[], context: string, muted: string[]): OllamaMessage[] {
  const system =
    `You are ${SCHOLARPEN_AI.name}, reviewing a section of an academic manuscript together with its author. ` +
    `Point out only problems worth the author's time: ${SCHOLARPEN_AI.reviewFocus}. ` +
    "Do not comment on style, wording preferences or grammar. " +
    "Do not invent references. If the section is sound, return no findings. " +
    (muted.length ? `The author asked not to be told about these kinds of issues: ${muted.join(", ")}. ` : "") +
    "Write each comment in the language of the manuscript, in one or two sentences, and say what to check or change. " +
    "Return JSON only, in this shape:\n" +
    `{"findings":[{"paragraph":1,"quote":"exact words copied from that paragraph","category":"${SCHOLARPEN_AI.categories.join("|")}","severity":"low|medium|high","comment":"..."}]}\n` +
    `Report at most ${MAX_NEW_PER_RUN} findings, most important first. The quote must be copied exactly from the paragraph and be at most 25 words.`;
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
  const parsed = JSON.parse(json) as { findings?: unknown[] };
  const findings: ReviewFinding[] = [];
  for (const raw of parsed.findings ?? []) {
    const item = raw as Record<string, unknown>;
    const paragraph = Number(item.paragraph);
    const severity = (["low", "medium", "high"].includes(String(item.severity)) ? item.severity : "medium") as ReviewSeverity;
    if (!Number.isInteger(paragraph) || paragraph < 1 || paragraph > paragraphCount) continue;
    if (typeof item.quote !== "string" || typeof item.comment !== "string" || !item.comment.trim()) continue;
    findings.push({
      paragraph: paragraph - 1,
      quote: item.quote,
      category: String(item.category ?? "logic"),
      severity,
      comment: item.comment.trim(),
    });
  }
  return findings;
}

/**
 * Reviews sections the author has finished working on and leaves its findings
 * as AI comment threads, within limits that keep comments from becoming noise.
 */
export class Reviewer {
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval> | null;
  private readonly lastAuto = new Map<string, number[]>();

  constructor(private readonly agent: CollabAgent, private readonly deps: ReviewerDeps) {
    this.now = deps.now ?? Date.now;
    this.timer = deps.tickMs === 0 ? null : setInterval(() => this.tick(), deps.tickMs ?? 15_000);
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

  /** Looks for sections that were edited and then left alone, and reviews one of them. */
  tick() {
    for (const attachment of this.agent.attachmentList()) {
      const { session } = attachment;
      const settings = reviewSettingsOf(session.ydoc.getMap(REVIEW_MAP));
      if (!settings.autoReview || this.agent.isPaused() || this.agent.isBusy(session.docKey)) continue;
      const history = (this.lastAuto.get(session.docKey) ?? []).filter((at) => this.now() - at < 3_600_000);
      if (history.length >= (this.deps.maxAutoPerHour ?? 12)) continue;
      if (history.length && this.now() - history[history.length - 1] < (this.deps.autoIntervalMs ?? 300_000)) continue;

      const doc = readDoc(session);
      const reviewed = session.ydoc.getMap(REVIEW_MAP).get("sections") as Record<string, { hash: string }> | undefined ?? {};
      const seen = new Set<string>();
      for (const block of doc.firstChild ? [...iterateTop(doc)] : []) {
        const section = sectionOf(doc, block.id);
        if (!section) continue;
        const key = sectionKey(section);
        if (seen.has(key)) continue;
        seen.add(key);
        const touched = Math.max(...section.blocks.map((b) => lastTouchedDeep(attachment, b)));
        if (touched === 0 || this.now() - touched < (this.deps.idleMs ?? 90_000)) continue;
        if (reviewed[key]?.hash === hashText(sectionFingerprint(doc, section))) continue;
        history.push(this.now());
        this.lastAuto.set(session.docKey, history);
        this.reviewSection(session.docKey, key, "auto");
        return;
      }
    }
  }

  private async runReview(attachment: Attachment, key: string, reason: "manual" | "auto", signal: AbortSignal) {
    const { session } = attachment;
    const reviewMap = session.ydoc.getMap(REVIEW_MAP);
    const settings = reviewSettingsOf(reviewMap);
    let doc = readDoc(session);
    const section = sectionOf(doc, key);
    if (!section) return;
    const prose = section.blocks.flatMap((block) => flatten(block))
      .filter((block) => hasInlineContent(block) && block.node.firstChild?.type.name !== "heading");
    const findings: Array<ReviewFinding & { blockId: string }> = [];

    // Deterministic check first: citations whose key is not in the bibliography.
    const keys = await this.deps.citekeys(session.projectPath);
    if (keys) {
      for (const block of prose) {
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

    if (prose.length > 0) {
      const paragraphs = prose.map((block) => readableText(doc, blockContent(block).from, blockContent(block).to));
      const first = section.blocks[0];
      const last = section.blocks[section.blocks.length - 1];
      const context = clip(readableText(doc, 0, first.pos), 3000, "end") + "\n[…this section…]\n" +
        clip(readableText(doc, last.pos + last.node.nodeSize, doc.content.size), 2000, "start");
      attachment.presence.claim(prose[0].id, "reviewing");
      const response = await this.deps.complete(
        buildReviewMessages(sectionTitle(section), paragraphs, context, settings.muted), signal);
      if (signal.aborted) throw new Error("Cancelled");
      for (const finding of parseFindings(response, prose.length)) {
        findings.push({ ...finding, blockId: prose[finding.paragraph].id });
      }
    }

    // Fatigue limits: threshold, muted kinds, duplicates, and per-section caps.
    const threads = session.ydoc.getMap(COLLAB_THREADS_MAP);
    const existing = readThreads(threads);
    const sectionIds = new Set(section.blocks.flatMap((block) => flatten(block)).map((block) => block.id));
    const openInSection = existing.filter((thread) => !thread.resolved && isAIUser(thread.comments[0]?.userId) &&
      thread.meta.blockId && sectionIds.has(thread.meta.blockId)).length;
    let budget = Math.min(MAX_NEW_PER_RUN, MAX_OPEN_PER_SECTION - openInSection);
    let added = 0;

    doc = readDoc(session);
    for (const finding of findings) {
      if (budget <= 0) break;
      if (SEVERITY_RANK[finding.severity] < SEVERITY_RANK[settings.minSeverity]) continue;
      if (settings.muted.includes(finding.category)) continue;
      const fingerprint = `${SCHOLARPEN_AI.id}:${finding.blockId}:${finding.category}:${normalize(finding.quote || finding.comment)}`;
      // Never raise a finding twice, including one the author already resolved.
      const duplicate = existing.some((thread) => thread.meta.fingerprint === fingerprint ||
        (!thread.resolved && thread.meta.blockId === finding.blockId &&
          (thread.meta.category === finding.category || normalize(thread.comments[0]?.text ?? "") === normalize(finding.comment))));
      if (duplicate) continue;
      const block = findBlock(doc, finding.blockId);
      if (!block) continue;
      const range = (finding.quote && locateQuote(block, finding.quote)) || blockContent(block);
      const meta: ThreadMeta = {
        agent: SCHOLARPEN_AI.id, category: finding.category, severity: finding.severity,
        blockId: finding.blockId, assignee: "me", status: "open", fingerprint,
      };
      session.ydoc.transact(() => {
        const threadId = createThread(threads, SCHOLARPEN_AI.userId, finding.comment, meta);
        anchorThread(session, block.id, threadId, AI_META_ORIGIN, range.from, range.to);
      }, AI_META_ORIGIN);
      doc = readDoc(session);
      existing.push(...readThreads(threads).filter((thread) => thread.meta.fingerprint === fingerprint));
      budget--;
      added++;
    }

    session.ydoc.transact(() => {
      const sections = { ...((reviewMap.get("sections") as Record<string, unknown> | undefined) ?? {}) };
      sections[key] = { hash: hashText(sectionFingerprint(readDoc(session), sectionOf(readDoc(session), key) ?? section)), at: this.now(), reason, added };
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
  const group = doc.firstChild!;
  let offset = 1;
  for (let i = 0; i < group.childCount; i++) {
    const node = group.child(i);
    if (node.type.name === "blockContainer") yield { id: node.attrs.id as string, pos: offset, node };
    offset += node.nodeSize;
  }
}

function lastTouchedDeep(attachment: Attachment, block: BlockRef) {
  return Math.max(...flatten(block).map((item) => attachment.presence.lastTouched(item.id)));
}

function hashText(text: string) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return `${text.length}:${hash >>> 0}`;
}
