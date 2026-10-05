import * as Y from "yjs";
import type { OllamaMessage } from "../../../shared/rpc-types";
import { COLLAB_FRAGMENT, COLLAB_THREADS_MAP } from "../../../shared/collab/protocol";
import {
  addThreadComment,
  aiRequestKey,
  readThreads,
  threadWantsAI,
  updateThreadMeta,
  type ThreadMeta,
  type ThreadSnapshot,
} from "../../../shared/collab/threads";
import type { AgentJobView } from "../../../shared/collab/agent-types";
import { isAIUser, SCHOLARPEN_AI } from "../../../shared/collab/personas";
import type { CollabRegistry, CollabSession } from "../registry";
import { applyBlockRewrite, captureBlock, nextSuggestionId, type BlockBase, type EditMode, type EditOutcome } from "./block-edit";
import { CHANGE_SETS_MAP, type ChangeSetInfo } from "../../../shared/collab/change-sets";
import {
  blockContent,
  blocksInRange,
  findBlock,
  hasInlineContent,
  listBlocks,
  readDoc,
  readableText,
  threadRange,
} from "./doc-model";
import { PresenceTracker } from "./presence";
import { buildCommentEditMessages, buildDocumentPlanMessages, clip, parseCommentEditResponse, parseDocumentPlan } from "./prompts";

/** Yjs transaction origin of every AI text edit; the undo manager tracks it. */
export const AI_ORIGIN = "ai-agent";
/** Origin of AI bookkeeping (comment anchors, review state) that "undo AI edit" must not revert. */
export const AI_META_ORIGIN = "ai-meta";
export const AI_EDITS_MAP = "aiEdits";

export interface CollabAgentDeps {
  complete(messages: OllamaMessage[], signal: AbortSignal): Promise<string>;
  onActivity(docKey: string, jobs: AgentJobView[]): void;
  now?: () => number;
  /** How long the AI waits for the author to leave a paragraph before working on it anyway. */
  waitForAuthorMs?: number;
  pollMs?: number;
  /** Decides suggestion vs direct edits for a block (zones refine this in stage 5). */
  editModeFor?: (session: CollabSession, blockId: string) => EditMode;
}

export interface Attachment {
  session: CollabSession;
  presence: PresenceTracker;
  undo: Y.UndoManager;
  stop: () => void;
  releaseHold: (() => void) | null;
}

interface Job {
  view: AgentJobView;
  run: (job: Job, attachment: Attachment, signal: AbortSignal) => Promise<void>;
}

/** Paragraphs sent to the model in one edit call. */
const MAX_BLOCKS_PER_CALL = 5;
/** Most paragraphs one request edits; larger requests continue on the next reply. */
const MAX_DOCUMENT_BLOCKS = 60;
/** Manuscript text per planning call; longer manuscripts are planned in parts. */
const PLAN_PART_CHARS = 60_000;
const RECENT_JOBS = 12;

let jobCounter = 0;

export class CollabAgent {
  private readonly attachments = new Map<string, Attachment>();
  private readonly queue: Job[] = [];
  private readonly history = new Map<string, AgentJobView[]>();
  private readonly seen = new Set<string>();
  private running: { job: Job; controller: AbortController } | null = null;
  private paused = false;
  private readonly now: () => number;
  private readonly stopRegistry: Array<() => void> = [];

  constructor(private readonly registry: CollabRegistry, private readonly deps: CollabAgentDeps) {
    this.now = deps.now ?? Date.now;
    for (const session of registry.list()) this.attach(session);
    const offOpened = registry.onSessionOpened((session) => this.attach(session));
    const offClosed = registry.onSessionClosed((session) => this.detach(session.docKey));
    this.stopRegistry.push(() => { offOpened(); }, () => { offClosed(); });
  }

  dispose() {
    this.running?.controller.abort();
    for (const stop of this.stopRegistry) stop();
    for (const docKey of [...this.attachments.keys()]) this.detach(docKey);
  }

  isPaused() {
    return this.paused;
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused) this.running?.controller.abort();
    else void this.pump();
  }

  jobs(docKey: string) {
    return this.history.get(docKey) ?? [];
  }

  /** Reverts the most recent AI change to the document text. */
  undoLast(docKey: string) {
    const attachment = this.attachments.get(docKey);
    if (!attachment || attachment.undo.undoStack.length === 0) return false;
    attachment.undo.undo();
    return true;
  }

  canUndo(docKey: string) {
    return (this.attachments.get(docKey)?.undo.undoStack.length ?? 0) > 0;
  }

  /** Re-checks a document's threads; used after an editor reconnects. */
  rescan(docKey: string) {
    const attachment = this.attachments.get(docKey);
    if (attachment) this.scanThreads(attachment);
  }

  private attach(session: CollabSession) {
    if (this.attachments.has(session.docKey)) return;
    const presence = new PresenceTracker(session, this.now);
    const undo = new Y.UndoManager(session.ydoc.getXmlFragment(COLLAB_FRAGMENT), {
      trackedOrigins: new Set([AI_ORIGIN]),
      captureTimeout: 0,
    });
    const threads = session.ydoc.getMap(COLLAB_THREADS_MAP);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onThreads = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => this.scanThreads(attachment), 250);
    };
    threads.observeDeep(onThreads);
    const attachment: Attachment = {
      session,
      presence,
      undo,
      releaseHold: null,
      stop: () => {
        if (timer) clearTimeout(timer);
        threads.unobserveDeep(onThreads);
      },
    };
    this.attachments.set(session.docKey, attachment);

    // Threads left "AI working" by an interrupted run go back to the queue.
    session.ydoc.transact(() => {
      for (const thread of readThreads(threads)) {
        if (thread.meta.status === "in-progress") {
          updateThreadMeta(threads, thread.id, { status: "open", statusNote: "Interrupted; retrying." });
        }
      }
    }, AI_META_ORIGIN);
    this.scanThreads(attachment);
  }

  private detach(docKey: string) {
    const attachment = this.attachments.get(docKey);
    if (!attachment) return;
    attachment.stop();
    attachment.presence.destroy();
    attachment.undo.destroy();
    this.attachments.delete(docKey);
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].view.docKey === docKey) this.queue.splice(i, 1);
    }
  }

  private scanThreads(attachment: Attachment) {
    const threads = readThreads(attachment.session.ydoc.getMap(COLLAB_THREADS_MAP));
    for (const thread of threads) {
      if (!threadWantsAI(thread)) continue;
      const last = [...thread.comments].reverse().find((comment) => !comment.deleted)!;
      const key = `${attachment.session.docKey}:${aiRequestKey(thread)}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.enqueue(attachment, {
        kind: "comment",
        threadId: thread.id,
        agent: SCHOLARPEN_AI.id,
        label: clip(last.text.replace(/\s+/g, " "), 80, "start"),
      }, (job, att, signal) => this.runCommentJob(job, att, thread.id, signal));
    }
  }

  /** Adds a job for a document; jobs run one at a time across all documents. */
  enqueue(
    attachment: Attachment,
    view: Pick<AgentJobView, "kind" | "label" | "threadId" | "blockId" | "agent">,
    run: Job["run"],
  ) {
    const job: Job = {
      view: { id: `job-${++jobCounter}`, docKey: attachment.session.docKey, state: "queued", createdAt: this.now(), ...view },
      run,
    };
    this.queue.push(job);
    this.record(job.view);
    void this.pump();
    return job.view.id;
  }

  attachmentFor(docKey: string) {
    return this.attachments.get(docKey) ?? null;
  }

  attachmentList() {
    return [...this.attachments.values()];
  }

  /** True while a job for this document is queued or running. */
  isBusy(docKey: string) {
    return this.running?.job.view.docKey === docKey || this.queue.some((job) => job.view.docKey === docKey);
  }

  private record(view: AgentJobView) {
    const list = (this.history.get(view.docKey) ?? []).filter((item) => item.id !== view.id);
    list.unshift({ ...view });
    this.history.set(view.docKey, list.slice(0, RECENT_JOBS));
    this.deps.onActivity(view.docKey, this.history.get(view.docKey)!);
  }

  private update(job: Job, patch: Partial<AgentJobView>) {
    Object.assign(job.view, patch);
    this.record(job.view);
  }

  private async pump(): Promise<void> {
    if (this.running || this.paused) return;
    const job = this.queue.shift();
    if (!job) return;
    const attachment = this.attachments.get(job.view.docKey);
    if (!attachment) return this.pump();
    const controller = new AbortController();
    this.running = { job, controller };
    attachment.releaseHold ??= this.registry.hold(job.view.docKey);
    this.update(job, { state: "working", startedAt: this.now() });
    try {
      await job.run(job, attachment, controller.signal);
      if (job.view.state === "working" || job.view.state === "waiting") this.update(job, { state: "done", finishedAt: this.now() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.update(job, { state: controller.signal.aborted ? "cancelled" : "failed", detail: message, finishedAt: this.now() });
    } finally {
      attachment.presence.release();
      this.running = null;
      if (!this.queue.some((queued) => queued.view.docKey === job.view.docKey)) {
        attachment.releaseHold?.();
        attachment.releaseHold = null;
      }
      void this.pump();
    }
  }

  /** Waits until the author is not in (or just editing) any of the blocks. */
  async waitForAuthor(job: Job, attachment: Attachment, blockIds: string[], signal: AbortSignal) {
    const deadline = this.now() + (this.deps.waitForAuthorMs ?? 60_000);
    const busy = () => blockIds.some((id) => attachment.presence.isBusy(id));
    if (!busy()) return;
    this.update(job, { state: "waiting", detail: "Waiting until you leave this passage" });
    while (busy() && this.now() < deadline) {
      if (signal.aborted) throw new Error("Cancelled");
      await new Promise((resolve) => setTimeout(resolve, this.deps.pollMs ?? 1500));
    }
    this.update(job, { state: "working", detail: undefined });
  }

  private setThread(attachment: Attachment, threadId: string, patch: Partial<ThreadMeta>, reply?: string) {
    const threads = attachment.session.ydoc.getMap(COLLAB_THREADS_MAP);
    attachment.session.ydoc.transact(() => {
      if (reply) addThreadComment(threads, threadId, SCHOLARPEN_AI.userId, reply);
      updateThreadMeta(threads, threadId, patch);
    }, AI_META_ORIGIN);
  }

  modeFor(attachment: Attachment, blockId: string): EditMode {
    return this.deps.editModeFor?.(attachment.session, blockId) ?? "auto";
  }

  /** Remembers blocks the AI changed directly so editors can highlight them. */
  markDirectEdit(attachment: Attachment, blockId: string, source: string) {
    attachment.session.ydoc.transact(() => {
      attachment.session.ydoc.getMap(AI_EDITS_MAP).set(blockId, { at: this.now(), source });
    }, AI_META_ORIGIN);
  }

  private async runCommentJob(job: Job, attachment: Attachment, threadId: string, signal: AbortSignal) {
    const { session } = attachment;
    const thread = readThreads(session.ydoc.getMap(COLLAB_THREADS_MAP)).find((item) => item.id === threadId);
    if (!thread || !threadWantsAI(thread)) return;
    const reply = (patch: Partial<ThreadMeta>, text?: string) => this.setThread(attachment, threadId, patch, text);
    reply({ assignee: "ai", agent: SCHOLARPEN_AI.id, status: "in-progress", statusNote: undefined });
    if (thread.meta.scope === "document") return this.runDocumentRequest(job, attachment, thread, reply, signal);

    const doc = readDoc(session);
    const range = threadRange(doc, threadId);
    if (!range) {
      reply({ assignee: "me", status: "open" },
        "I can't find the commented passage anymore. Re-select the text and comment again.");
      return;
    }
    const blocks = blocksInRange(doc, range.from, range.to).filter(hasInlineContent);
    if (blocks.length === 0) {
      reply({ assignee: "me", status: "open" },
        "This passage has no editable prose (it is an equation, figure or empty block), so I left it unchanged.");
      return;
    }
    if (blocks.length > MAX_DOCUMENT_BLOCKS) {
      reply({ assignee: "me", status: "open" },
        `This comment spans ${blocks.length} paragraphs. Comment on ${MAX_DOCUMENT_BLOCKS} or fewer at a time so I can edit them safely.`);
      return;
    }
    const result = await this.editBlocks(job, attachment, thread, blocks.map((block) => block.id), {
      quoted: readableText(doc, range.from, range.to),
      allowWiderScope: true,
    }, signal);
    if (result === "document") {
      // The thread asks for more than its passage; from now on it is about the whole manuscript.
      reply({ scope: "document" });
      return this.runDocumentRequest(job, attachment, { ...thread, meta: { ...thread.meta, scope: "document" } }, reply, signal);
    }
    this.finishEdit(job, attachment, thread, result, reply);
  }

  /** A request about the whole manuscript: find the paragraphs it touches, then edit them in batches. */
  private async runDocumentRequest(job: Job, attachment: Attachment, thread: ThreadSnapshot,
    reply: (patch: Partial<ThreadMeta>, text?: string) => void, signal: AbortSignal) {
    const doc = readDoc(attachment.session);
    const prose = listBlocks(doc).filter(hasInlineContent);
    if (prose.length === 0) {
      reply({ assignee: "me", status: "open" }, "The manuscript has no editable prose yet, so I left it unchanged.");
      return;
    }
    const paragraphs = prose.map((block, index) => ({
      number: index + 1,
      kind: blockContent(block).node.type.name,
      text: readableText(doc, blockContent(block).from, blockContent(block).to),
    }));
    // Long manuscripts are read in parts that each fit one model call.
    const parts: Array<typeof paragraphs> = [[]];
    let size = 0;
    for (const paragraph of paragraphs) {
      if (size > 0 && size + paragraph.text.length > PLAN_PART_CHARS) {
        parts.push([]);
        size = 0;
      }
      parts[parts.length - 1].push(paragraph);
      size += paragraph.text.length;
    }

    this.update(job, { detail: "Reading the manuscript" });
    attachment.presence.claim(prose[0].id, "reading");
    const chosen = new Set<number>();
    let summary = "";
    for (let index = 0; index < parts.length; index++) {
      const response = await this.deps.complete(buildDocumentPlanMessages({
        conversation: conversationOf(thread),
        paragraphs: parts[index],
        part: parts.length > 1 ? { index: index + 1, total: parts.length } : undefined,
      }), signal);
      if (signal.aborted) throw new Error("Cancelled");
      const plan = parseDocumentPlan(response, new Set(parts[index].map((paragraph) => paragraph.number)));
      plan.paragraphs.forEach((number) => chosen.add(number));
      summary ||= plan.summary;
    }
    attachment.presence.release();

    const targets = [...chosen].sort((a, b) => a - b).map((number) => prose[number - 1].id);
    if (targets.length === 0) {
      reply({ assignee: "me", status: "open", statusNote: undefined }, summary || "Nothing in the manuscript needs to change for this.");
      return;
    }
    const capped = targets.slice(0, MAX_DOCUMENT_BLOCKS);
    const result = await this.editBlocks(job, attachment, thread, capped, { summary }, signal);
    if (result === "document") return;
    if (targets.length > capped.length) {
      result.notes.push(`${targets.length} paragraphs need this change; I edited the first ${capped.length}. Reply here to continue with the rest.`);
    }
    this.finishEdit(job, attachment, thread, result, reply);
  }

  /**
   * Rewrites the given blocks for the thread, a few paragraphs per model call,
   * as one change set. Returns "document" when the model says the request
   * needs the whole manuscript (only when `allowWiderScope` is set).
   */
  private async editBlocks(job: Job, attachment: Attachment, thread: ThreadSnapshot, blockIds: string[],
    options: { quoted?: string; summary?: string; allowWiderScope?: boolean }, signal: AbortSignal): Promise<EditResult | "document"> {
    const { session } = attachment;
    const batches: string[][] = [];
    for (let index = 0; index < blockIds.length; index += MAX_BLOCKS_PER_CALL) batches.push(blockIds.slice(index, index + MAX_BLOCKS_PER_CALL));
    const result: EditResult = {
      outcomes: [], replies: [], notes: [], summary: options.summary,
      // Everything this request changes is one change set, accepted or rejected together.
      changeSetId: nextSuggestionId(readDoc(session)),
      paragraphs: blockIds.length,
    };
    this.update(job, { blockId: blockIds[0] });

    for (let index = 0; index < batches.length; index++) {
      if (batches.length > 1) this.update(job, { detail: `Editing part ${index + 1} of ${batches.length}` });
      await this.waitForAuthor(job, attachment, batches[index], signal);
      // Read the paragraphs now, after waiting: this is the base the stale check compares against.
      const doc = readDoc(session);
      const fresh = batches[index].map((id) => findBlock(doc, id)).filter((block): block is NonNullable<typeof block> => !!block);
      if (fresh.length < batches[index].length) {
        result.notes.push(batches.length > 1
          ? "Some paragraphs were deleted before I reached them, so I skipped them."
          : "Part of the commented passage was deleted before I started, so I left it alone.");
        if (batches.length === 1) break;
      }
      if (fresh.length === 0) continue;
      attachment.presence.claim(fresh[0].id, "editing");
      const bases: BlockBase[] = fresh.map((block) => captureBlock(block));
      const first = blockContent(fresh[0]);
      const last = blockContent(fresh[fresh.length - 1]);
      const response = await this.deps.complete(buildCommentEditMessages({
        conversation: conversationOf(thread),
        passage: joinProtections(bases),
        quoted: options.quoted,
        before: clip(readableText(doc, 0, first.from), 6000, "end"),
        after: clip(readableText(doc, last.to, doc.content.size), 3000, "start"),
        part: options.quoted === undefined ? { index: index + 1, total: batches.length } : undefined,
        allowWiderScope: options.allowWiderScope,
      }), signal);
      if (signal.aborted) throw new Error("Cancelled");

      const parsed = parseCommentEditResponse(response);
      if (parsed.wantsDocument && options.allowWiderScope && index === 0) return "document";
      if (parsed.reply) result.replies.push(parsed.reply);
      if (parsed.passage === null) continue;
      let parts: string[];
      try {
        parts = splitProtected(bases, parsed.passage);
      } catch (error) {
        if (batches.length === 1) throw error;
        result.notes.push(`Part ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      for (let at = 0; at < bases.length; at++) {
        const outcome = applyBlockRewrite(session, bases[at], parts[at],
          this.modeFor(attachment, bases[at].blockId), AI_ORIGIN, result.changeSetId);
        result.outcomes.push(outcome);
        if (outcome.kind === "applied" && outcome.mode === "direct") this.markDirectEdit(attachment, bases[at].blockId, `comment:${thread.id}`);
      }
      attachment.presence.release();
    }
    return result;
  }

  private finishEdit(job: Job, attachment: Attachment, thread: ThreadSnapshot, result: EditResult,
    reply: (patch: Partial<ThreadMeta>, text?: string) => void) {
    const { session } = attachment;
    const suggested = result.outcomes.some((outcome) => outcome.kind === "applied" && outcome.mode === "suggest");
    if (suggested) {
      session.ydoc.transact(() => {
        session.ydoc.getMap<ChangeSetInfo>(CHANGE_SETS_MAP).set(String(result.changeSetId), {
          id: result.changeSetId,
          label: clip(conversationOf(thread).at(-1)?.text.replace(/\s+/g, " ") ?? "AI edit", 80, "start"),
          persona: SCHOLARPEN_AI.id,
          threadId: thread.id,
          createdAt: this.now(),
        });
      }, AI_META_ORIGIN);
    }
    const lead = result.summary || result.replies[0] || "";
    const changed = result.outcomes.filter((outcome) => outcome.kind === "applied").length;
    const notes = [...result.notes];
    if (result.paragraphs > MAX_BLOCKS_PER_CALL) notes.unshift(`Changed ${changed} of ${result.paragraphs} paragraphs.`);
    const { text, meta } = summarize(lead, result.outcomes, notes);
    reply(suggested ? { ...meta, changeSet: result.changeSetId } : meta, text);
    this.update(job, { detail: meta.statusNote ?? undefined });
  }
}

interface EditResult {
  outcomes: EditOutcome[];
  replies: string[];
  notes: string[];
  summary?: string;
  changeSetId: number;
  paragraphs: number;
}

function conversationOf(thread: ThreadSnapshot) {
  return thread.comments
    .filter((comment) => !comment.deleted)
    .map((comment) => ({ author: isAIUser(comment.userId) ? "ai" as const : "author" as const, text: comment.text }));
}

/** Several blocks are sent as one passage separated by a protected block marker. */
const BLOCK_SEPARATOR = (index: number) => `⟦SP:BLOCK:${index}⟧`;

function joinProtections(bases: BlockBase[]) {
  if (bases.length === 1) return bases[0].protection;
  return {
    ...bases[0].protection,
    protectedText: bases.map((base, index) => `${index > 0 ? `${BLOCK_SEPARATOR(index)}\n` : ""}${base.protection.protectedText}`).join("\n"),
  };
}

function splitProtected(bases: BlockBase[], passage: string) {
  if (bases.length === 1) return [passage];
  const parts: string[] = [];
  let rest = passage;
  for (let index = 1; index < bases.length; index++) {
    const marker = BLOCK_SEPARATOR(index);
    const at = rest.indexOf(marker);
    if (at < 0) throw new Error("The AI merged or dropped a paragraph boundary; nothing was changed.");
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at + marker.length);
  }
  parts.push(rest.trim());
  return parts;
}

const MAX_CONFLICT_PREVIEWS = 3;

function summarize(reply: string, outcomes: EditOutcome[], notes: string[] = []): { text: string; meta: Partial<ThreadMeta> } {
  const applied = outcomes.filter((outcome): outcome is Extract<EditOutcome, { kind: "applied" }> => outcome.kind === "applied");
  const conflicts = outcomes.filter((outcome): outcome is Extract<EditOutcome, { kind: "conflict" }> => outcome.kind === "conflict");
  const lines = [reply || (applied.length ? "Done." : "I didn't change the text.")];

  if (applied.some((outcome) => outcome.mode === "suggest")) {
    lines.push("My edits are marked as suggestions in the text. Accept or reject them together from this thread or the Activity panel.");
  }
  if (applied.some((outcome) => outcome.mode === "direct")) {
    lines.push("Small corrections were applied directly; you can undo them from the Activity panel.");
  }
  if (applied.some((outcome) => outcome.rebased)) {
    lines.push("You edited this passage while I worked; I merged my changes around yours.");
  }
  for (const conflict of conflicts.slice(0, MAX_CONFLICT_PREVIEWS)) {
    lines.push(`${conflict.reason} I didn't change the text. Here is what I would write:\n\n${conflict.preview}`);
  }
  if (conflicts.length > MAX_CONFLICT_PREVIEWS) {
    lines.push(`${conflicts.length - MAX_CONFLICT_PREVIEWS} more paragraphs were left as proposals for the same reason.`);
  }
  lines.push(...notes);

  if (conflicts.length > 0) {
    const observed = conflicts.every((conflict) => conflict.reason.includes("Observe"));
    return { text: lines.join("\n\n"), meta: { assignee: "me", status: "proposed",
      statusNote: observed ? "Proposal only — this section is set to Observe." : "Proposal only — the passage changed while the AI worked." } };
  }
  if (applied.length > 0) {
    return { text: lines.join("\n\n"), meta: { assignee: "me", status: "proposed", statusNote: undefined } };
  }
  return { text: lines.join("\n\n"), meta: { assignee: "me", status: "open", statusNote: undefined } };
}
