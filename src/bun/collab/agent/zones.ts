import { randomUUID } from "crypto";
import { AI_WRITING_STYLE } from "../../../shared/ai-writing-style";
import { Fragment, Slice, type Node as PMNode, type Schema } from "prosemirror-model";
import type { OllamaMessage } from "../../../shared/rpc-types";
import { COLLAB_THREADS_MAP } from "../../../shared/collab/protocol";
import { AI_USER_ID, createThread } from "../../../shared/collab/threads";
import { SCHOLARPEN_AI } from "../../../shared/collab/personas";
import { ZONES_MAP, zoneOf, type Zone } from "../../../shared/collab/zones";
import type { CollabSession } from "../registry";
import { AI_EDITS_MAP, AI_META_ORIGIN, AI_ORIGIN, type Attachment, type CollabAgent } from "./agent";
import type { EditMode } from "./block-edit";
import { anchorThread, readDoc, readableText, removePlaceholders, sectionOf, topLevel, writeBlock, writeTopLevel } from "./doc-model";
import { AI_PLACEHOLDER_TYPE } from "../../../shared/collab/ai-placeholder";
import { clip } from "./prompts";

/** Maps a block's zone to how AI edits may land there. */
export function zoneEditMode(session: CollabSession, blockId: string): EditMode {
  const section = sectionOf(readDoc(session), blockId);
  const zone = zoneOf(session.ydoc.getMap<Zone>(ZONES_MAP), section?.heading?.id);
  switch (zone.trust) {
    case "observe": return "observe";
    case "suggest": return "suggest";
    case "edit": return "direct";
    default: return "auto";
  }
}

const CITATION = /\[(@[^\]]+)\]/g;

/** One drafted paragraph as ProseMirror inline content, with [@key] turned into citation nodes. */
export function paragraphContent(schema: Schema, text: string): PMNode[] {
  const nodes: PMNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(CITATION)) {
    const before = text.slice(cursor, match.index);
    if (before) nodes.push(schema.text(before));
    for (const part of match[1].split(";")) {
      const [key, ...locator] = part.trim().replace(/^@/, "").split(",");
      if (!key.trim()) continue;
      nodes.push(schema.nodes.citation.create({ citekey: key.trim(), locator: locator.join(",").trim() }));
    }
    cursor = (match.index ?? 0) + match[0].length;
  }
  const rest = text.slice(cursor);
  if (rest) nodes.push(schema.text(rest));
  return nodes;
}

function draftSystem() {
  return "You are ScholarPen AI, drafting one section of an academic manuscript for its author, who will revise it. " +
    "Turn the author's notes into finished academic prose in the language of the notes. " +
    "Use only facts in the notes and the rest of the manuscript; when something is missing, write a clearly marked placeholder such as [TODO: sample size]. " +
    "Keep every citation exactly as written in the notes, in the form [@citekey]; never invent citations. " +
    "Match the voice and terminology of the rest of the manuscript. " +
    AI_WRITING_STYLE;
}

function sectionInput(title: string, brief: string, notes: string, context: string) {
  return `<section_title>${title}</section_title>\n\n` +
    (brief ? `<author_brief>\n${brief}\n</author_brief>\n\n` : "") +
    `<notes>\n${notes || "(no notes yet)"}\n</notes>\n\n` +
    `<rest_of_manuscript reference_only="true">\n${context}\n</rest_of_manuscript>`;
}

/** First call: the section's paragraphs as a plan, one line each, shown in the document before any text is written. */
function planMessages(title: string, brief: string, notes: string, context: string): OllamaMessage[] {
  const system = draftSystem() + "\n\n" +
    `First plan the section. Decide the paragraphs it needs (1 to ${MAX_DRAFT_PARAGRAPHS}) and, for each, say in one short sentence what it will say, ` +
    "in the language of the notes; the author reads this plan while you write. " +
    'Return only JSON: {"paragraphs":[{"intent":"…"}]}';
  return [{ role: "system", content: system }, { role: "user", content: sectionInput(title, brief, notes, context) }];
}

/** One call per planned paragraph, written in order. */
function paragraphMessages(title: string, brief: string, notes: string, context: string, plan: string[], index: number, written: string[]): OllamaMessage[] {
  const system = draftSystem() + "\n\n" +
    `Write paragraph ${index + 1} of ${plan.length} of this section, following its plan. ` +
    "Continue naturally from the paragraphs already written and leave the topics of later paragraphs to them. " +
    "Return only this one paragraph: no heading, no list, no commentary.";
  const user = sectionInput(title, brief, notes, context) + "\n\n" +
    `<section_plan>\n${plan.map((intent, i) => `${i + 1}. ${intent}`).join("\n")}\n</section_plan>\n\n` +
    (written.length ? `<written_so_far>\n${written.join("\n\n")}\n</written_so_far>\n\n` : "") +
    `<this_paragraph>${index + 1}. ${plan[index]}</this_paragraph>`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

/** The planned paragraphs, or null when the model returned prose instead of a plan. */
export function parseDraftPlan(output: string): string[] | null {
  const text = output.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { paragraphs?: unknown };
    if (!Array.isArray(parsed.paragraphs)) return null;
    const intents = parsed.paragraphs
      .map((item) => typeof item === "string" ? item : typeof (item as { intent?: unknown })?.intent === "string" ? (item as { intent: string }).intent : "")
      .map((intent) => intent.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, MAX_DRAFT_PARAGRAPHS);
    return intents.length ? intents : null;
  } catch {
    return null;
  }
}

/** Drafted prose split into paragraphs (headings and model reasoning dropped). */
function proseParagraphs(output: string) {
  return output.replace(/<think>[\s\S]*?<\/think>/g, "")
    .split(/\n\s*\n/)
    .map((text) => text.replace(/^#+\s.*$/gm, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const MAX_DRAFT_PARAGRAPHS = 8;

/**
 * Drafts prose for a section the author handed to the AI (trust "edit"),
 * appending it after the section's notes, and opens a thread asking for review.
 */
export function enqueueDraft(
  agent: CollabAgent,
  docKey: string,
  headingId: string,
  complete: (messages: OllamaMessage[], signal: AbortSignal) => Promise<string>,
) {
  const attachment = agent.attachmentFor(docKey);
  if (!attachment) throw new Error("This document is not open.");
  const section = sectionOf(readDoc(attachment.session), headingId);
  if (!section?.heading) throw new Error("Put the cursor in a section that starts with a heading.");
  const zone = zoneOf(attachment.session.ydoc.getMap<Zone>(ZONES_MAP), section.heading.id);
  if (zone.trust !== "edit") throw new Error("Set this section to “AI drafts” before asking the AI to draft it.");
  const title = section.heading.node.firstChild?.textContent.trim() ?? "Section";
  return agent.enqueue(attachment, { kind: "draft", label: title, blockId: section.heading.id },
    (job, att, signal) => runDraft(att, section.heading!.id, async (messages, callSignal) => {
      const policy = await agent.policyFor(att.session, "structural", "draft");
      return complete(messages.map((message, index) => index === 0 ? { ...message, content: `${message.content}\n\n${policy}` } : message), callSignal);
    }, signal, (detail) => agent.reportProgress(job, detail)));
}

/** Ids of a drafting job's placeholders still in the document, in order. */
function placeholdersOf(doc: PMNode, draftId: string) {
  const found: string[] = [];
  doc.firstChild?.forEach((node) => {
    if (node.firstChild?.type.name === AI_PLACEHOLDER_TYPE && node.firstChild.attrs.draft === draftId) found.push(node.attrs.id);
  });
  return found;
}

/**
 * Drafts a section in view of the author: one call plans its paragraphs and
 * the plan appears in place as placeholder blocks; each placeholder is then
 * written in turn and replaced by its paragraph. The author may reword or
 * drop a placeholder that is still waiting; the AI follows what it then says.
 * A model that answers the plan with prose gets that prose inserted at once.
 */
async function runDraft(
  attachment: Attachment,
  headingId: string,
  complete: (messages: OllamaMessage[], signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
  progress: (detail: string) => void = () => {},
) {
  const { session } = attachment;
  let doc = readDoc(session);
  const section = sectionOf(doc, headingId);
  if (!section?.heading) throw new Error("The section heading was removed.");
  const zone = zoneOf(session.ydoc.getMap<Zone>(ZONES_MAP), headingId);
  const body = section.blocks.slice(1);
  const notes = body.map((block) => readableText(doc, block.pos, block.pos + block.node.nodeSize)).join("\n");
  const first = section.blocks[0];
  const last = section.blocks[section.blocks.length - 1];
  const context = clip(readableText(doc, 0, first.pos), 4000, "end") + "\n[…this section…]\n" +
    clip(readableText(doc, last.pos + last.node.nodeSize, doc.content.size), 2000, "start");
  const title = section.heading.node.firstChild?.textContent ?? "";
  const brief = zone.brief ?? "";
  const schema = session.schema;
  attachment.presence.claim(headingId, "drafting");
  progress("Planning the section");
  const planned = await complete(planMessages(title, brief, notes, context), signal);
  if (signal.aborted) throw new Error("Cancelled");
  const plan = parseDraftPlan(planned);

  /** Where new blocks go: after the section's last top-level block, read now. */
  const insertionPoint = () => {
    doc = readDoc(session);
    const current = sectionOf(doc, headingId);
    if (!current) throw new Error("The section was removed while drafting.");
    const anchor = current.blocks[current.blocks.length - 1];
    return anchor.pos + anchor.node.nodeSize;
  };

  const ids: string[] = [];
  if (!plan) {
    // No plan: the answer is the draft itself.
    const paragraphs = proseParagraphs(planned);
    if (paragraphs.length === 0) throw new Error("The model returned no text.");
    const blocks = paragraphs.map((text) => {
      const id = randomUUID();
      ids.push(id);
      return schema.nodes.blockContainer.create({ id }, [schema.nodes.paragraph.create(null, paragraphContent(schema, text))]);
    });
    const at = insertionPoint();
    writeTopLevel(session, doc.replace(at, at, new Slice(Fragment.from(blocks), 0, 0)), AI_ORIGIN);
  } else {
    const draftId = randomUUID();
    const placeholders = plan.map((intent) => schema.nodes.blockContainer.create({ id: randomUUID() },
      [schema.nodes[AI_PLACEHOLDER_TYPE].create({ intent, state: "pending", draft: draftId })]));
    const at = insertionPoint();
    writeTopLevel(session, doc.replace(at, at, new Slice(Fragment.from(placeholders), 0, 0)), AI_META_ORIGIN);
    // The whole draft is one "undo AI edit", as when it arrived at once.
    const undo = attachment.undo;
    const captureTimeout = undo.captureTimeout;
    undo.stopCapturing();
    undo.captureTimeout = Number.POSITIVE_INFINITY;
    try {
      const written: string[] = [];
      const writtenIntents: string[] = [];
      for (;;) {
        if (signal.aborted) throw new Error("Cancelled");
        // The plan as it stands now: the author may have reworded or dropped placeholders.
        doc = readDoc(session);
        const waiting = placeholdersOf(doc, draftId);
        if (!waiting.length) break;
        const id = waiting[0];
        const intents = [...writtenIntents, ...waiting.map((blockId) => String(topLevel(doc, blockId)!.node.firstChild!.attrs.intent ?? ""))];
        const position = written.length;
        progress(`Writing paragraph ${position + 1} of ${intents.length}`);
        const placeholder = topLevel(doc, id)!;
        writeBlock(session, schema.nodes.blockContainer.create({ id }, [schema.nodes[AI_PLACEHOLDER_TYPE].create({ ...placeholder.node.firstChild!.attrs, state: "writing" })]), AI_META_ORIGIN);
        const output = await complete(paragraphMessages(title, brief, notes, context, intents, position, written), signal);
        if (signal.aborted) throw new Error("Cancelled");
        const text = proseParagraphs(output).join(" ");
        doc = readDoc(session);
        const current = topLevel(doc, id);
        if (!current) continue; // dropped while it was being written
        if (!text) throw new Error("The model returned no text.");
        // The placeholder goes (not undoable); the paragraph arrives in its place as an AI edit, so undo removes it cleanly.
        writeTopLevel(session, doc.replace(current.pos, current.pos + current.node.nodeSize, Slice.empty), AI_META_ORIGIN);
        doc = readDoc(session);
        const paragraphId = randomUUID();
        const paragraph = schema.nodes.blockContainer.create({ id: paragraphId }, [schema.nodes.paragraph.create(null, paragraphContent(schema, text))]);
        writeTopLevel(session, doc.replace(current.pos, current.pos, new Slice(Fragment.from(paragraph), 0, 0)), AI_ORIGIN);
        ids.push(paragraphId);
        written.push(text);
        writtenIntents.push(intents[position]);
      }
    } finally {
      undo.stopCapturing();
      undo.captureTimeout = captureTimeout;
      removePlaceholders(session, draftId);
    }
    if (!ids.length) return;
  }

  session.ydoc.transact(() => {
    const edits = session.ydoc.getMap(AI_EDITS_MAP);
    for (const id of ids) edits.set(id, { at: Date.now(), source: `draft:${headingId}` });
    // Open a review thread on the first drafted paragraph.
    const threads = session.ydoc.getMap(COLLAB_THREADS_MAP);
    const threadId = createThread(threads, AI_USER_ID,
      `I drafted ${ids.length} paragraph${ids.length === 1 ? "" : "s"} from your notes. ` +
      "Check the facts and any [TODO] placeholders; reply with @AI to have me revise.",
      { agent: SCHOLARPEN_AI.id, assignee: "me", status: "proposed", blockId: ids[0], category: "draft" });
    anchorThread(session, ids[0], threadId, AI_META_ORIGIN);
  }, AI_META_ORIGIN);
}
