import { randomUUID } from "crypto";
import { Fragment, Slice, type Node as PMNode, type Schema } from "prosemirror-model";
import { updateYFragment } from "y-prosemirror";
import * as Y from "yjs";
import type { OllamaMessage } from "../../../shared/rpc-types";
import { COLLAB_FRAGMENT, COLLAB_THREADS_MAP } from "../../../shared/collab/protocol";
import { AI_USER_ID, createThread } from "../../../shared/collab/threads";
import { SCHOLARPEN_AI } from "../../../shared/collab/personas";
import { ZONES_MAP, zoneOf, type Zone } from "../../../shared/collab/zones";
import type { CollabSession } from "../registry";
import { AI_EDITS_MAP, AI_META_ORIGIN, AI_ORIGIN, type Attachment, type CollabAgent } from "./agent";
import type { EditMode } from "./block-edit";
import { anchorThread, readDoc, readableText, sectionOf } from "./doc-model";
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

function draftMessages(title: string, brief: string, notes: string, context: string): OllamaMessage[] {
  const system =
    "You are ScholarPen AI, drafting one section of an academic manuscript for its author, who will revise it. " +
    "Turn the author's notes into finished academic prose in the language of the notes. " +
    "Use only facts in the notes and the rest of the manuscript; when something is missing, write a clearly marked placeholder such as [TODO: sample size]. " +
    "Keep every citation exactly as written in the notes, in the form [@citekey]; never invent citations. " +
    "Match the voice and terminology of the rest of the manuscript. " +
    "Return only the paragraphs, separated by blank lines: no heading, no lists, no commentary.";
  const user =
    `<section_title>${title}</section_title>\n\n` +
    (brief ? `<author_brief>\n${brief}\n</author_brief>\n\n` : "") +
    `<notes>\n${notes || "(no notes yet)"}\n</notes>\n\n` +
    `<rest_of_manuscript reference_only="true">\n${context}\n</rest_of_manuscript>`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

/** Writes the top-level block list back to the shared Y.Doc with a minimal diff. */
function writeTopLevel(session: CollabSession, doc: PMNode, origin: unknown) {
  const root = session.ydoc.getXmlFragment(COLLAB_FRAGMENT).get(0);
  if (!(root instanceof Y.XmlElement) || root.nodeName !== "blockGroup") throw new Error("Unexpected document structure.");
  session.ydoc.transact(() => {
    updateYFragment(session.ydoc, root, doc.firstChild!, { mapping: new Map(), isOMark: new Map() });
  }, origin);
}

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
    (job, att, signal) => runDraft(att, section.heading!.id, complete, signal));
}

async function runDraft(
  attachment: Attachment,
  headingId: string,
  complete: (messages: OllamaMessage[], signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
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
  attachment.presence.claim(headingId, "drafting");
  const response = await complete(
    draftMessages(section.heading.node.firstChild?.textContent ?? "", zone.brief ?? "", notes, context), signal);
  if (signal.aborted) throw new Error("Cancelled");

  const paragraphs = response.replace(/<think>[\s\S]*?<\/think>/g, "")
    .split(/\n\s*\n/)
    .map((text) => text.replace(/^#+\s.*$/gm, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (paragraphs.length === 0) throw new Error("The model returned no text.");

  // Insert after the section's last top-level block, re-reading the document now.
  doc = readDoc(session);
  const current = sectionOf(doc, headingId);
  if (!current) throw new Error("The section was removed while drafting.");
  const anchor = current.blocks[current.blocks.length - 1];
  const schema = session.schema;
  const ids = paragraphs.map(() => randomUUID());
  const blocks = paragraphs.map((text, index) => schema.nodes.blockContainer.create(
    { id: ids[index] },
    [schema.nodes.paragraph.create(null, paragraphContent(schema, text))],
  ));
  const at = anchor.pos + anchor.node.nodeSize;
  const updated = doc.replace(at, at, new Slice(Fragment.from(blocks), 0, 0));
  writeTopLevel(session, updated, AI_ORIGIN);

  session.ydoc.transact(() => {
    const edits = session.ydoc.getMap(AI_EDITS_MAP);
    for (const id of ids) edits.set(id, { at: Date.now(), source: `draft:${headingId}` });
    // Open a review thread on the first drafted paragraph.
    const threads = session.ydoc.getMap(COLLAB_THREADS_MAP);
    const threadId = createThread(threads, AI_USER_ID,
      `I drafted ${paragraphs.length} paragraph${paragraphs.length === 1 ? "" : "s"} from your notes. ` +
      "Check the facts and any [TODO] placeholders; reply with @AI to have me revise.",
      { agent: SCHOLARPEN_AI.id, assignee: "me", status: "proposed", blockId: ids[0], category: "draft" });
    anchorThread(session, ids[0], threadId, AI_META_ORIGIN);
  }, AI_META_ORIGIN);
}
