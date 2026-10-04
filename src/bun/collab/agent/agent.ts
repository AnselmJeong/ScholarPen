import * as Y from "yjs";
import type { OllamaMessage } from "../../../shared/rpc-types";
import { COLLAB_FRAGMENT, COLLAB_THREADS_MAP } from "../../../shared/collab/protocol";
import {
  AI_USER_ID,
  addThreadComment,
  aiRequestKey,
  readThreads,
  threadWantsAI,
  updateThreadMeta,
  type ThreadMeta,
  type ThreadSnapshot,
} from "../../../shared/collab/threads";
import type { AgentJobView } from "../../../shared/collab/agent-types";
import type { CollabRegistry, CollabSession } from "../registry";
import { applyBlockRewrite, captureBlock, type BlockBase, type EditMode, type EditOutcome } from "./block-edit";
import {
  blockContent,
  blocksInRange,
  findBlock,
  hasInlineContent,
  readDoc,
  readableText,
  threadRange,
} from "./doc-model";
import { PresenceTracker } from "./presence";
import { buildCommentEditMessages, clip, parseCommentEditResponse } from "./prompts";

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

const MAX_BLOCKS_PER_THREAD = 5;
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
        label: clip(last.text.replace(/\s+/g, " "), 80, "start"),
      }, (job, att, signal) => this.runCommentJob(job, att, thread.id, signal));
    }
  }

  /** Adds a job for a document; jobs run one at a time across all documents. */
  enqueue(
    attachment: Attachment,
    view: Pick<AgentJobView, "kind" | "label" | "threadId" | "blockId">,
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
      if (reply) addThreadComment(threads, threadId, AI_USER_ID, reply);
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
    this.setThread(attachment, threadId, { assignee: "ai", status: "in-progress", statusNote: undefined });

    let doc = readDoc(session);
    const range = threadRange(doc, threadId);
    if (!range) {
      this.setThread(attachment, threadId, { assignee: "me", status: "open" },
        "I can't find the commented passage anymore. Re-select the text and comment again.");
      return;
    }
    const blocks = blocksInRange(doc, range.from, range.to).filter(hasInlineContent);
    if (blocks.length === 0) {
      this.setThread(attachment, threadId, { assignee: "me", status: "open" },
        "This passage has no editable prose (it is an equation, figure or empty block), so I left it unchanged.");
      return;
    }
    if (blocks.length > MAX_BLOCKS_PER_THREAD) {
      this.setThread(attachment, threadId, { assignee: "me", status: "open" },
        `This comment spans ${blocks.length} paragraphs. Comment on ${MAX_BLOCKS_PER_THREAD} or fewer at a time so I can edit them safely.`);
      return;
    }
    this.update(job, { blockId: blocks[0].id });

    await this.waitForAuthor(job, attachment, blocks.map((block) => block.id), signal);
    attachment.presence.claim(blocks[0].id, "editing");

    // Read the passage now, after waiting: this is the base the stale check compares against.
    doc = readDoc(session);
    const fresh = blocks.map((block) => findBlock(doc, block.id));
    if (fresh.some((block) => !block)) {
      this.setThread(attachment, threadId, { assignee: "me", status: "open" },
        "Part of the commented passage was deleted before I started, so I left it alone.");
      return;
    }
    const bases: BlockBase[] = fresh.map((block) => captureBlock(block!));
    const first = blockContent(fresh[0]!);
    const last = blockContent(fresh[fresh.length - 1]!);
    const response = await this.deps.complete(buildCommentEditMessages({
      conversation: conversationOf(thread),
      passage: joinProtections(bases),
      quoted: readableText(doc, range.from, range.to),
      before: clip(readableText(doc, 0, first.from), 6000, "end"),
      after: clip(readableText(doc, last.to, doc.content.size), 3000, "start"),
    }), signal);
    if (signal.aborted) throw new Error("Cancelled");

    const parsed = parseCommentEditResponse(response);
    const outcomes: EditOutcome[] = [];
    if (parsed.passage !== null) {
      const parts = splitProtected(bases, parsed.passage);
      for (let index = 0; index < bases.length; index++) {
        const outcome = applyBlockRewrite(session, bases[index], parts[index], this.modeFor(attachment, bases[index].blockId), AI_ORIGIN);
        outcomes.push(outcome);
        if (outcome.kind === "applied" && outcome.mode === "direct") this.markDirectEdit(attachment, bases[index].blockId, `comment:${threadId}`);
      }
    }
    const { text, meta } = summarize(parsed.reply, outcomes);
    this.setThread(attachment, threadId, meta, text);
    this.update(job, { detail: meta.statusNote ?? undefined });
  }
}

function conversationOf(thread: ThreadSnapshot) {
  return thread.comments
    .filter((comment) => !comment.deleted)
    .map((comment) => ({ author: comment.userId === AI_USER_ID ? "ai" as const : "author" as const, text: comment.text }));
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

function summarize(reply: string, outcomes: EditOutcome[]): { text: string; meta: Partial<ThreadMeta> } {
  const applied = outcomes.filter((outcome): outcome is Extract<EditOutcome, { kind: "applied" }> => outcome.kind === "applied");
  const conflicts = outcomes.filter((outcome): outcome is Extract<EditOutcome, { kind: "conflict" }> => outcome.kind === "conflict");
  const lines = [reply || (applied.length ? "Done." : "I didn't change the text.")];

  if (applied.some((outcome) => outcome.mode === "suggest")) {
    lines.push("My edits are marked as suggestions in the text. Accept or reject them from the Activity panel.");
  }
  if (applied.some((outcome) => outcome.mode === "direct")) {
    lines.push("Small corrections were applied directly; you can undo them from the Activity panel.");
  }
  if (applied.some((outcome) => outcome.rebased)) {
    lines.push("You edited this passage while I worked; I merged my changes around yours.");
  }
  for (const conflict of conflicts) {
    lines.push(`${conflict.reason} I didn't change the text. Here is what I would write:\n\n${conflict.preview}`);
  }

  if (conflicts.length > 0) {
    return { text: lines.join("\n\n"), meta: { assignee: "me", status: "proposed", statusNote: "Proposal only — the passage changed while the AI worked." } };
  }
  if (applied.length > 0) {
    return { text: lines.join("\n\n"), meta: { assignee: "me", status: "proposed", statusNote: undefined } };
  }
  return { text: lines.join("\n\n"), meta: { assignee: "me", status: "open", statusNote: undefined } };
}
