import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import { fileSystem } from "../fs/manager";
import type { CollabSession } from "../collab/registry";
import { readDoc, writeTopLevel } from "../collab/agent/doc-model";
import { AI_EDITS_MAP, AI_ORIGIN } from "../collab/agent/origins";
import { acceptedDoc } from "../collab/history/encode";
import type { ResponseItem, ReviewSession } from "../../shared/review-session/types";
import {
  letterBlocksFromJSON, letterDocumentBlocks, letterDocumentFilename, letterResponses, responseBlocks, responseRange,
  type LetterBlock,
} from "../../shared/review-session/letter-document";
import { decisionSources, type DecisionSources } from "./decision-sources";
import { exists, readJSON, writeJSON } from "./workspace";

/**
 * `<record>/letter/.scholarpen/letter-document.json`: the letter document of
 * a session and, per comment, the response text last written into it. A
 * section that still reads that text is the AI's to rewrite; one the author
 * changed is theirs.
 */
const RECORD = ".scholarpen/letter-document.json";
export interface LetterDocumentRecord { schemaVersion: 1; filename: string; written: Record<string, string> }

export async function readLetterRecord(letter: string): Promise<LetterDocumentRecord | null> {
  if (!await exists(letter, RECORD)) return null;
  const record = await readJSON<LetterDocumentRecord>(letter, RECORD).catch(() => null);
  return record?.schemaVersion === 1 && typeof record.filename === "string" && record.written && typeof record.written === "object" ? record : null;
}

/** Top-level blocks of the live document, pending suggestions left out. */
export function letterBlocksFromDoc(doc: PMNode): LetterBlock[] {
  const blocks: LetterBlock[] = [];
  doc.firstChild?.forEach((node) => {
    if (node.type.name !== "blockContainer") return;
    const content = node.firstChild;
    blocks.push({
      id: String(node.attrs.id ?? ""),
      type: content?.type.name ?? "",
      text: content ? content.textBetween(0, content.content.size, "\n", (leaf) => leaf.type.spec.leafText?.(leaf) ?? "") : "",
    });
  });
  return blocks;
}

/** The document's shared state while an editor has it open (a session only held by background work reads from its JSON). */
async function liveSession(project: string, filename: string, sources: DecisionSources) {
  const session = await sources.openSession(project, filename);
  return session && session.peers.size > 0 ? session : null;
}

/** The letter document as it now reads: from the open editor's shared state, else its saved JSON; null when it is gone. */
export async function readLetterBlocks(project: string, filename: string, sources: DecisionSources = decisionSources()): Promise<LetterBlock[] | null> {
  const session = await liveSession(project, filename, sources);
  if (session) return letterBlocksFromDoc(acceptedDoc(readDoc(session), session.schema));
  try { return letterBlocksFromJSON(await sources.documentJSON(project, filename)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/**
 * The responses with the letter document's wording wherever the author changed
 * it there; a section still reading what was written into it keeps the saved
 * response (so the document's paragraph layout never counts as an edit).
 */
export async function overlayLetterDocument(project: string, letter: string, session: ReviewSession, responses: ResponseItem[]): Promise<ResponseItem[]> {
  const record = await readLetterRecord(letter);
  if (!record) return responses;
  const blocks = await readLetterBlocks(project, record.filename);
  if (!blocks) return responses;
  const document = letterResponses(blocks, session.comments.map(comment => comment.id));
  return responses.map(response => {
    const text = document.get(response.commentId);
    return text === undefined || text === record.written[response.commentId] ? response : { ...response, response: text };
  });
}

/** Creates the letter document from the current responses, or returns the one already made. */
export async function ensureLetterDocument(project: string, letter: string, session: ReviewSession, responses: ResponseItem[]): Promise<{ filename: string; created: boolean }> {
  const record = await readLetterRecord(letter);
  if (record && await readLetterBlocks(project, record.filename)) return { filename: record.filename, created: false };
  const blocks = letterDocumentBlocks(session, responses);
  let filename = letterDocumentFilename(session.id);
  await mkdir(join(project, "documents", filename.split("/")[0]), { recursive: true });
  // Never overwrite a document the record does not know (e.g. one the author made by hand).
  for (let suffix = 2; await exists(join(project, "documents"), filename); suffix++) {
    filename = letterDocumentFilename(session.id).replace(/\.scholarpen\.json$/, `-${suffix}.scholarpen.json`);
  }
  await fileSystem.saveDocument(project, filename, blocks);
  const written = Object.fromEntries(letterResponses(letterBlocksFromJSON(blocks), session.comments.map(comment => comment.id)));
  await writeJSON(letter, RECORD, { schemaVersion: 1, filename, written } satisfies LetterDocumentRecord);
  return { filename, created: true };
}

/** Writes rewritten responses into the letter document, keeping every section the author changed there. */
export async function writeLetterResponses(project: string, letter: string, session: ReviewSession, rewritten: Map<string, string>, sources: DecisionSources = decisionSources()): Promise<{ updated: string[]; kept: string[] } | null> {
  const record = await readLetterRecord(letter);
  if (!record || !rewritten.size) return null;
  const ids = session.comments.map(comment => comment.id);
  const open = await liveSession(project, record.filename, sources);
  const before = open ? letterBlocksFromDoc(acceptedDoc(readDoc(open), open.schema)) : await readLetterBlocks(project, record.filename, sources);
  if (!before) return null;
  const current = letterResponses(before, ids);
  const updated: string[] = [];
  const kept: string[] = [];
  const targets = new Map<string, string>();
  for (const [id, text] of rewritten) {
    if (!current.has(id)) { kept.push(id); continue; }
    if (current.get(id) !== record.written[id]) { kept.push(id); continue; }
    if (current.get(id) === text) continue;
    targets.set(id, text);
  }
  if (targets.size) {
    if (open) writeOpenLetter(open, ids, targets);
    else await writeClosedLetter(project, record.filename, ids, targets, sources);
    const after = await readLetterBlocks(project, record.filename, sources);
    const read = after ? letterResponses(after, ids) : new Map<string, string>();
    for (const id of targets.keys()) {
      if (read.has(id)) { record.written[id] = read.get(id)!; updated.push(id); }
    }
    await writeJSON(letter, RECORD, record);
  }
  return { updated, kept };
}

function writeOpenLetter(session: CollabSession, ids: string[], targets: Map<string, string>) {
  let doc = readDoc(session);
  const schema = session.schema;
  const newIds: string[] = [];
  // Last section first, so earlier positions stay valid.
  const ranges = [...targets.keys()].map(id => ({ id, range: responseRange(letterBlocksFromDoc(doc), id, ids) }))
    .filter((item): item is { id: string; range: { start: number; end: number } } => !!item.range)
    .sort((a, b) => b.range.start - a.range.start);
  for (const { id, range } of ranges) {
    const positions: number[] = [];
    doc.firstChild!.forEach((_node, offset) => { positions.push(offset + 1); });
    const from = range.start < positions.length ? positions[range.start] : doc.firstChild!.nodeSize - 1;
    const to = range.end < positions.length ? positions[range.end] : doc.firstChild!.nodeSize - 1;
    const stamp = Date.now().toString(36);
    const blocks = responseBlocks(id, targets.get(id)!, index => `letter-${id}-${stamp}-p${index}`).map((block) => {
      newIds.push(block.id);
      const value = (block.content as Array<{ text: string }>)[0]?.text ?? "";
      return schema.nodes.blockContainer.create({ id: block.id }, [schema.nodes[block.type].create(null, value ? schema.text(value) : null)]);
    });
    doc = doc.replace(from, to, new Slice(Fragment.from(blocks), 0, 0));
  }
  writeTopLevel(session, doc, AI_ORIGIN);
  session.ydoc.transact(() => {
    const edits = session.ydoc.getMap(AI_EDITS_MAP);
    for (const id of newIds) edits.set(id, { at: Date.now(), source: "letter" });
  }, AI_ORIGIN);
}

async function writeClosedLetter(project: string, filename: string, ids: string[], targets: Map<string, string>, sources: DecisionSources) {
  const json = await sources.documentJSON(project, filename);
  if (!Array.isArray(json)) return;
  let blocks = [...json];
  const ranges = [...targets.keys()].map(id => ({ id, range: responseRange(letterBlocksFromJSON(blocks), id, ids) }))
    .filter((item): item is { id: string; range: { start: number; end: number } } => !!item.range)
    .sort((a, b) => b.range.start - a.range.start);
  const stamp = Date.now().toString(36);
  for (const { id, range } of ranges) {
    blocks = [...blocks.slice(0, range.start), ...responseBlocks(id, targets.get(id)!, index => `letter-${id}-${stamp}-p${index}`), ...blocks.slice(range.end)];
  }
  await fileSystem.saveDocument(project, filename, blocks);
}
