import { leafText } from '../collab/schema-spec';
import type { ResponseItem, ReviewSession } from './types';

/**
 * The response letter as a document the author edits in the main editor:
 * `documents/response-letters/<name>.scholarpen.json`. It is not part of the
 * manuscript, so manuscript-wide features (map, consistency, review scope,
 * Ask AI sources, cross-references) leave it out.
 *
 * Each reviewer comment is a level-2 heading with the id `letter-<commentId>`,
 * the comment itself in quote blocks, and a "Response" heading with the id
 * `letter-<commentId>-response`; the response is everything after that heading
 * up to the next comment's heading (or the end).
 */
export const LETTER_DOCUMENTS_FOLDER = 'response-letters';

export function isLetterDocument(filename: string) {
  return filename.startsWith(`${LETTER_DOCUMENTS_FOLDER}/`);
}

/** `response-letters/response-<date>-<id8>.scholarpen.json`, named like the session's export folder. */
export function letterDocumentFilename(sessionId: string) {
  const [year, month, day, , uuid] = sessionId.split('-');
  return `${LETTER_DOCUMENTS_FOLDER}/response-${year}-${month}-${day}-${uuid}.scholarpen.json`;
}

export const commentHeadingId =(commentId: string) => `letter-${commentId}`;
export const responseHeadingId = (commentId: string) => `letter-${commentId}-response`;

/** One top-level block as the letter reads it, from BlockNote JSON or the live document. */
export interface LetterBlock { id: string; type: string; text: string }

type JsonBlock = { id: string; type: string; props?: Record<string, unknown>; content?: unknown; children?: unknown[] };

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];
const heading = (id: string, level: 1 | 2 | 3, value: string): JsonBlock => ({ id, type: 'heading', props: { level }, content: text(value), children: [] });

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

/** A response as blocks: one paragraph per blank-line-separated part, list lines as list items. */
export function responseBlocks(commentId: string, response: string, idFor: (index: number) => string = index => `letter-${commentId}-p${index}`): JsonBlock[] {
  const blocks: JsonBlock[] = [];
  for (const part of response.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = part.split('\n').map(line => line.trimEnd()).filter(line => line.trim());
    if (!lines.length) continue;
    // List lines become list items; the lines between them, one paragraph.
    let prose: string[] = [];
    const flush = () => {
      if (prose.length) blocks.push({ id: idFor(blocks.length), type: 'paragraph', props: {}, content: text(prose.join(' ')), children: [] });
      prose = [];
    };
    for (const line of lines) {
      const list = BULLET.test(line) ? 'bulletListItem' : NUMBERED.test(line) ? 'numberedListItem' : null;
      if (!list) { prose.push(line.trim()); continue; }
      flush();
      blocks.push({ id: idFor(blocks.length), type: list, props: {}, content: text(line.replace(list === 'bulletListItem' ? BULLET : NUMBERED, '')), children: [] });
    }
    flush();
  }
  return blocks;
}

/** The whole letter as BlockNote JSON, in the order of the session's comments. */
export function letterDocumentBlocks(session: ReviewSession, responses: ResponseItem[]): JsonBlock[] {
  const byId = new Map(responses.map(response => [response.commentId, response]));
  const blocks: JsonBlock[] = [heading('letter-title', 1, 'Response to the Editor and Reviewers')];
  if (session.input.mode === 'virtual') blocks.push({ id: 'letter-virtual', type: 'paragraph', props: {}, content: text('Virtual review simulation — not external peer review.'), children: [] });
  for (const comment of session.comments) {
    blocks.push(heading(commentHeadingId(comment.id), 2, `${comment.reviewerId} · ${comment.id}`));
    blocks.push(heading(`letter-${comment.id}-comment`, 3, 'Reviewer comment'));
    comment.original.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(part => part.trim()).filter(Boolean).forEach((part, index) => {
      blocks.push({ id: `letter-${comment.id}-q${index}`, type: 'quote', props: {}, content: text(part.replace(/\s*\n\s*/g, ' ')), children: [] });
    });
    blocks.push(heading(responseHeadingId(comment.id), 3, 'Response'));
    blocks.push(...responseBlocks(comment.id, byId.get(comment.id)?.response ?? ''));
  }
  return blocks;
}

function inlineText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    const item = part as { type?: string; text?: string; content?: unknown; props?: Record<string, unknown> };
    if (item?.type === 'text') return item.text ?? '';
    if (item?.type === 'link') return inlineText(item.content);
    return item?.type ? leafText({ type: { name: item.type }, attrs: item.props ?? {} }) : '';
  }).join('');
}

/** Top-level blocks of a saved letter document (its JSON snapshot). */
export function letterBlocksFromJSON(json: unknown): LetterBlock[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap(value => {
    const block = value as JsonBlock;
    return block && typeof block.id === 'string' ? [{ id: block.id, type: String(block.type ?? ''), text: inlineText(block.content) }] : [];
  });
}

/** Where one comment's response lies among the top-level blocks: [start, end), or null when its "Response" heading is gone. */
export function responseRange(blocks: LetterBlock[], commentId: string, commentIds: string[]): { start: number; end: number } | null {
  const at = blocks.findIndex(block => block.id === responseHeadingId(commentId));
  if (at < 0) return null;
  const headings = new Set(commentIds.map(commentHeadingId));
  let end = at + 1;
  while (end < blocks.length && !headings.has(blocks[end].id)) end++;
  return { start: at + 1, end };
}

/** A response's text as the document now reads it (the same form `responseBlocks` writes). */
export function responseText(blocks: LetterBlock[]): string {
  let number = 0;
  const lines = blocks.map(block => {
    if (block.type === 'numberedListItem') return `${++number}. ${block.text.trim()}`;
    number = 0;
    if (block.type === 'bulletListItem') return `- ${block.text.trim()}`;
    return block.text.trim();
  });
  // Consecutive list items stay one part; everything else is a paragraph of its own.
  const parts: string[] = [];
  blocks.forEach((block, index) => {
    const line = lines[index];
    if (!line) return;
    const list = block.type === 'bulletListItem' || block.type === 'numberedListItem';
    if (list && index > 0 && blocks[index - 1].type === block.type && parts.length) parts[parts.length - 1] += `\n${line}`;
    else parts.push(line);
  });
  return parts.join('\n\n');
}

/** Each comment's response as the letter document reads it; a comment whose "Response" heading is gone is left out. */
export function letterResponses(blocks: LetterBlock[], commentIds: string[]): Map<string, string> {
  const responses = new Map<string, string>();
  for (const id of commentIds) {
    const range = responseRange(blocks, id, commentIds);
    if (range) responses.set(id, responseText(blocks.slice(range.start, range.end)));
  }
  return responses;
}
