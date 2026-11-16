import * as Y from "yjs";
import { EditorState } from "prosemirror-state";
import { revertSuggestions } from "@handlewithcare/prosemirror-suggest-changes";
import type { CollabSession } from "../collab/registry";
import { blockContent, findBlock, readDoc, readableText } from "../collab/agent/doc-model";
import { COLLAB_FRAGMENT } from "../../shared/collab/protocol";
import { leafText } from "../../shared/collab/schema-spec";
import { readProposalEntries, REVIEW_PROPOSALS_MAP, type ProposalEntry, type ProposalState } from "../../shared/collab/review-proposals";
import type { ReviewProposal, StagedProposals } from "../../shared/review-session/proposals";
import type { Disposition, ResponseItem, ReviewComment, ReviewSession } from "../../shared/review-session/types";
import { array, object, parseModelJSON, string } from "../../shared/review-session/schema";
import type { DecisionSources } from "./decision-sources";
import { hash } from "./workspace";

/** The author's final word on a proposal: these states rewrite the response to the reviewer. */
export const SETTLED_STATES: ReadonlySet<ProposalState> = new Set(["accepted", "edited", "rejected", "dismissed"]);

export interface ProposalDecision {
  proposal: ReviewProposal;
  /** "not-shown": the document has not been opened since the proposals were staged. */
  state: ProposalState | "not-shown";
  /** The paragraph as the manuscript now reads (pending suggestions left out). */
  final: string | null;
  instruction?: string;
  redoCount?: number;
}

export const settled = (decision: ProposalDecision) => decision.state !== "not-shown" && SETTLED_STATES.has(decision.state);
const applied = (decision: ProposalDecision) => decision.state === "accepted" || decision.state === "edited";

function acceptedBlockText(session: CollabSession, blockId: string) {
  let doc = readDoc(session);
  revertSuggestions(EditorState.create({ schema: session.schema, doc }), (tr) => { doc = tr.doc; });
  const block = findBlock(doc, blockId);
  if (!block) return null;
  const content = blockContent(block);
  return readableText(doc, content.from, content.to);
}

function inlineText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => {
    const item = part as { type?: string; text?: string; content?: unknown; props?: Record<string, unknown> };
    if (item?.type === "text") return item.text ?? "";
    if (item?.type === "link") return inlineText(item.content);
    // Atoms read exactly as in the live document, so a closed and an open document give the same paragraph.
    return item?.type ? leafText({ type: { name: item.type }, attrs: item.props ?? {} }) : "";
  }).join("");
  const table = content as { rows?: Array<{ cells?: unknown[] }> } | null;
  if (table?.rows) return table.rows.map((row) => (row.cells ?? []).map((cell) =>
    inlineText((cell as { content?: unknown })?.content ?? cell)).join(" | ")).join("\n");
  return "";
}

function jsonBlockText(blocks: unknown, blockId: string): string | null {
  if (!Array.isArray(blocks)) return null;
  for (const value of blocks) {
    const block = value as { id?: string; content?: unknown; children?: unknown };
    if (block?.id === blockId) return inlineText(block.content);
    const nested = jsonBlockText(block?.children, blockId);
    if (nested !== null) return nested;
  }
  return null;
}

/** What became of each staged proposal, read from the documents' shared state. */
export async function proposalDecisions(sources: DecisionSources, project: string, staged: StagedProposals): Promise<ProposalDecision[]> {
  const byDocument = new Map<string, ReviewProposal[]>();
  for (const proposal of staged.proposals) byDocument.set(proposal.document, [...(byDocument.get(proposal.document) ?? []), proposal]);
  const decisions: ProposalDecision[] = [];
  for (const [document, proposals] of byDocument) {
    const session = await sources.openSession(project, document);
    let entries: ProposalEntry[] = [];
    let finalText: (blockId: string) => string | null;
    if (session && session.ydoc.getXmlFragment(COLLAB_FRAGMENT).length > 0) {
      entries = readProposalEntries(session.ydoc.getMap<ProposalEntry>(REVIEW_PROPOSALS_MAP));
      finalText = (blockId) => acceptedBlockText(session, blockId);
    } else {
      const state = await sources.storedState(project, document);
      if (state) {
        const ydoc = new Y.Doc();
        Y.applyUpdate(ydoc, state);
        entries = readProposalEntries(ydoc.getMap<ProposalEntry>(REVIEW_PROPOSALS_MAP));
        ydoc.destroy();
      }
      const json = await sources.documentJSON(project, document).catch(() => null);
      finalText = (blockId) => jsonBlockText(json, blockId);
    }
    for (const proposal of proposals) {
      const entry = entries.find((item) => item.key === proposal.key);
      decisions.push({
        proposal, state: entry?.state ?? "not-shown", final: entry ? finalText(proposal.blockId) : null,
        ...(entry?.instruction ? { instruction: entry.instruction } : {}),
        ...(entry?.redoCount ? { redoCount: entry.redoCount } : {}),
      });
    }
  }
  return decisions;
}

export interface CommentSyncState {
  commentId: string;
  /** Proposals that answer this comment. */
  proposals: number;
  /** Of those, still waiting for the author in the manuscript. */
  waiting: number;
  ready: boolean;
  fingerprint: string;
}

/** Comments whose proposals are all settled; general comments once every proposal is. */
export function commentSyncStates(comments: ReviewComment[], decisions: ProposalDecision[]): CommentSyncState[] {
  const everything = decisions.length > 0 && decisions.every(settled);
  const print = (items: ProposalDecision[]) => hash(JSON.stringify(items.map((item) =>
    [item.proposal.key, item.state, item.final, item.instruction ?? ""])));
  return comments.map((comment) => {
    const linked = decisions.filter((decision) => decision.proposal.comments.some((item) => item.id === comment.id));
    return {
      commentId: comment.id, proposals: linked.length,
      waiting: linked.filter((decision) => !settled(decision)).length,
      ready: linked.length ? linked.every(settled) : everything,
      fingerprint: print(linked.length ? linked : decisions),
    };
  });
}

const korean = (language: string) => /korean|한국|한글/i.test(language);
const title = (document: string) => document.replace(/\.scholarpen\.json$/, "");
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;

function decisionLabel(decision: ProposalDecision) {
  switch (decision.state) {
    case "accepted": return decision.redoCount ? "accepted a revised version the author requested" : "accepted as proposed";
    case "edited": return "accepted, then rewritten by the author";
    case "rejected": return "rejected; the original wording was kept";
    default: return "not applied; the original wording was kept";
  }
}

/** Text a reviewer must never see: internal ids, file names, review-tool notes. */
export const INTERNAL_TEXT = /\b(?:[CA]\d+-p\d+|RESPONSE\d+-)|scholarpen\.json|저자 확인 필요|자동 검토|자동으로 적용|Author confirmation required|automated review|not-verified/i;

export function buildResponsePrompt(session: ReviewSession, comments: ReviewComment[], current: ResponseItem[], decisions: ProposalDecision[]) {
  const ko = korean(session.input.language);
  const items = comments.map((comment) => {
    const linked = decisions.filter((decision) => decision.proposal.comments.some((item) => item.id === comment.id));
    return {
      commentId: comment.id, reviewer: comment.reviewerId, comment: comment.original,
      previousDraft: clip(current.find((item) => item.commentId === comment.id)?.response ?? "", 3000),
      decisions: linked.map((decision) => ({
        section: title(decision.proposal.document), decision: decisionLabel(decision),
        originalWording: clip(decision.proposal.before, 1500), proposedWording: clip(decision.proposal.after, 1500),
        paragraphNow: clip(decision.final ?? "", 3000), ...(decision.instruction ? { authorInstruction: decision.instruction } : {}),
      })),
    };
  });
  const system = "You write the authors' response letter to the editor and journal reviewers. You are precise and never claim a change the manuscript does not contain.";
  const prompt = `Write the final response to each reviewer comment below, in ${session.input.language || (ko ? "Korean" : "English")}.

The authors have just decided every proposed revision in the manuscript itself. Base each response ONLY on those decisions and on the paragraph as it now reads ("paragraphNow"):
- Accepted or rewritten: thank the reviewer briefly, say what was changed and where (by section name), and quote the revised wording from paragraphNow (the relevant sentences, not the whole paragraph when it is long).
- Original wording kept: say the passage was retained. Give a reason only if authorInstruction states one; never invent a justification. Without one, end that part with exactly one bracketed note to the authors asking for their reason${ko ? ", e.g. [저자: 원문을 유지한 이유를 적어 주세요]" : ", e.g. [Authors: state why the original wording was kept]"}.
- No decisions (a general comment or the editor's decision): write a short, courteous reply that summarizes the revisions made across the other comments; do not claim anything beyond them.
- previousDraft was written before the authors decided; use its wording only where it still matches the decisions.
- Never mention AI, automated review, verification status, internal ids (such as C1-p2 or A1-p1), file names or block ids. No headings, no Markdown tables; plain paragraphs and "> " quotes only.

Return only JSON: {"responses":[{"commentId":string,"response":string}]}, one entry per comment, same commentIds.

Comments and decisions:
${JSON.stringify(items, null, 1)}`;
  return { system, prompt };
}

export function parseResponseRewrite(output: string, commentIds: string[]) {
  const responses = new Map<string, string>();
  for (const value of array(object(parseModelJSON(output)).responses)) {
    const item = object(value);
    const id = string(item.commentId);
    const response = string(item.response).trim();
    if (commentIds.includes(id) && response) responses.set(id, response);
  }
  return responses;
}

/** A plain response from the decisions alone, when the model cannot write one. */
export function templateResponse(session: ReviewSession, comment: ReviewComment, decisions: ProposalDecision[]) {
  const ko = korean(session.input.language);
  const linked = decisions.filter((decision) => decision.proposal.comments.some((item) => item.id === comment.id));
  if (!linked.length) return ko
    ? "귀중한 의견에 감사드립니다. 각 의견에 따른 구체적인 수정 사항은 아래 항목별 답변에 정리하였습니다."
    : "We thank you for your comments. The specific revisions made in response are described in the replies to each comment below.";
  const parts = [ko ? "귀중한 의견에 감사드립니다." : "We thank the reviewer for this comment."];
  for (const decision of linked) {
    const where = title(decision.proposal.document);
    if (applied(decision)) {
      const quote = clip(decision.final ?? decision.proposal.after, 900).split("\n").map((line) => `> ${line}`).join("\n");
      parts.push(ko ? `지적해 주신 내용을 반영하여 「${where}」의 해당 부분을 다음과 같이 수정하였습니다.\n\n${quote}`
        : `In response, we revised the relevant passage in "${where}" as follows:\n\n${quote}`);
    } else {
      parts.push(ko ? `「${where}」의 해당 부분은 검토 끝에 원래 서술을 유지하였습니다. [저자: 원문을 유지한 이유를 적어 주세요]`
        : `After consideration, we retained the original wording in "${where}". [Authors: state why the original wording was kept]`);
    }
  }
  return parts.join("\n\n");
}

export function dispositionFor(comment: ReviewComment, decisions: ProposalDecision[]): Disposition {
  const linked = decisions.filter((decision) => decision.proposal.comments.some((item) => item.id === comment.id));
  const changed = linked.filter(applied).length;
  if (!linked.length || !changed) return "clarified-no-change";
  return changed === linked.length ? "changed" : "partially-addressed";
}

export interface ResponseRewriteDeps {
  complete(system: string, prompt: string): Promise<string>;
}

/**
 * Rewrites the responses of `comments` from the author's decisions: the model
 * writes them (one format retry), and a response that still carries internal
 * notes, or is missing, falls back to a plain one built from the decisions.
 */
export async function rewriteResponses(session: ReviewSession, comments: ReviewComment[], current: ResponseItem[], decisions: ProposalDecision[], deps: ResponseRewriteDeps) {
  const ids = comments.map((comment) => comment.id);
  const { system, prompt } = buildResponsePrompt(session, comments, current, decisions);
  const written = new Map<string, string>();
  let error: string | undefined;
  for (let attempt = 0; attempt < 2 && written.size < ids.length; attempt++) {
    try {
      const output = await deps.complete(system, attempt ? `${prompt}\n\nYour previous answer was not valid JSON with clean responses for every commentId. Return the JSON object only.` : prompt);
      const parsed = parseResponseRewrite(output, ids);
      for (const [id, text] of parsed) if (!INTERNAL_TEXT.test(text)) written.set(id, text);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  const responses = new Map<string, { response: string; method: "model" | "template" }>();
  for (const comment of comments) {
    const text = written.get(comment.id);
    responses.set(comment.id, text ? { response: text, method: "model" } : { response: templateResponse(session, comment, decisions), method: "template" });
  }
  return { responses, error };
}

/** The response items after a rewrite: text, disposition and the locations actually changed. */
export function applyRewrittenResponses(items: ResponseItem[], comments: ReviewComment[], rewritten: Map<string, { response: string }>, decisions: ProposalDecision[]) {
  for (const item of items) {
    const next = rewritten.get(item.commentId);
    const comment = comments.find((value) => value.id === item.commentId);
    if (!next || !comment) continue;
    const linked = decisions.filter((decision) => decision.proposal.comments.some((value) => value.id === comment.id));
    item.response = next.response;
    item.disposition = dispositionFor(comment, decisions);
    item.changeIds = linked.filter(applied).map((decision) => decision.proposal.id);
    item.locations = [...new Set(linked.map((decision) => `${decision.proposal.document}#${decision.proposal.blockId}`))];
    // The author decided every linked change in the manuscript.
    item.verification = "verified";
  }
  return items;
}
