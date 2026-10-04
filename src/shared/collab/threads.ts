import * as Y from "yjs";
import { DEFAULT_PERSONA_ID, PERSONAS, isAIUser, mentionedPersona, personaById, type Persona } from "./personas";

// Comment threads live in the shared Y.Doc in BlockNote's YjsThreadStore format
// (see @blocknote/core comments/threadstore/yjs/yjsHelpers). These helpers let
// Bun read and write that format without loading BlockNote.

export const LOCAL_USER_ID = "me";
/** Comment author id of the default AI persona. */
export const AI_USER_ID = PERSONAS[0].userId;

export type ThreadAssignee = "ai" | "me";
export type ThreadStatus = "open" | "in-progress" | "proposed" | "resolved";

/** ScholarPen-specific fields stored in BlockNote's free-form thread metadata. */
export interface ThreadMeta {
  assignee?: ThreadAssignee | null;
  status?: ThreadStatus;
  /** Human-readable note for the current status, e.g. why the AI downgraded an edit. */
  statusNote?: string;
  /** Id of the AI persona that opened or owns the thread (see personas.ts). */
  agent?: string;
  /** Review finding category and severity for AI-opened threads. */
  category?: string;
  severity?: "low" | "medium" | "high";
  /** The block the thread was anchored to when the AI opened it. */
  blockId?: string;
  /** User feedback: hide this kind of finding in future reviews. */
  muted?: boolean;
  /** Identity of a review finding, so a dismissed finding is not raised again. */
  fingerprint?: string;
  /** Set when the author hands the thread to the AI, so a repeated request is a new job. */
  requestedAt?: number;
}

export interface ThreadComment {
  id: string;
  userId: string;
  createdAt: number;
  text: string;
  deleted: boolean;
}

export interface ThreadSnapshot {
  id: string;
  createdAt: number;
  updatedAt: number;
  resolved: boolean;
  meta: ThreadMeta;
  comments: ThreadComment[];
}

type Block = { type?: string; content?: unknown; children?: Block[] };

/** Plain text of a BlockNote comment body (an array of blocks). */
export function commentBodyText(body: unknown): string {
  if (!Array.isArray(body)) return "";
  const lines: string[] = [];
  const visit = (block: Block) => {
    const content = block.content;
    if (typeof content === "string") lines.push(content);
    else if (Array.isArray(content)) {
      lines.push(content.map((part: any) => {
        if (part?.type === "text") return part.text ?? "";
        if (part?.type === "link") return (part.content ?? []).map((c: any) => c.text ?? "").join("");
        if (part?.type === "mention") return `@${part.props?.user ?? ""}`;
        return "";
      }).join(""));
    }
    block.children?.forEach(visit);
  };
  body.forEach((block) => visit(block as Block));
  return lines.join("\n").trim();
}

/** A comment body BlockNote can render: one paragraph per line. */
export function textCommentBody(text: string) {
  return text.split(/\n{2,}/).map((paragraph) => ({
    type: "paragraph",
    props: {},
    content: [{ type: "text", text: paragraph.trim(), styles: {} }],
    children: [],
  }));
}

export function readThread(thread: Y.Map<any>): ThreadSnapshot {
  const comments = (thread.get("comments") as Y.Array<Y.Map<any>> | undefined)?.toArray() ?? [];
  return {
    id: thread.get("id"),
    createdAt: thread.get("createdAt"),
    updatedAt: thread.get("updatedAt"),
    resolved: !!thread.get("resolved"),
    meta: (thread.get("metadata") as ThreadMeta | undefined) ?? {},
    comments: comments.map((comment) => ({
      id: comment.get("id"),
      userId: comment.get("userId"),
      createdAt: comment.get("createdAt"),
      text: commentBodyText(comment.get("body")),
      deleted: !!comment.get("deletedAt"),
    })),
  };
}

export function readThreads(threads: Y.Map<any>): ThreadSnapshot[] {
  return [...threads.values()]
    .filter((thread): thread is Y.Map<any> => thread instanceof Y.Map && !thread.get("deletedAt"))
    .map(readThread);
}

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function commentMap(userId: string, body: unknown, now: number) {
  const comment = new Y.Map<any>();
  comment.set("id", newId());
  comment.set("userId", userId);
  comment.set("createdAt", now);
  comment.set("updatedAt", now);
  comment.set("body", body);
  comment.set("reactionsByUser", new Y.Map());
  comment.set("metadata", undefined);
  return comment;
}

/** Creates a thread; the caller anchors it in the document with a comment mark. */
export function createThread(threads: Y.Map<any>, userId: string, text: string, meta: ThreadMeta) {
  const now = Date.now();
  const thread = new Y.Map<any>();
  const id = newId();
  thread.set("id", id);
  thread.set("createdAt", now);
  thread.set("updatedAt", now);
  const comments = new Y.Array<Y.Map<any>>();
  comments.push([commentMap(userId, textCommentBody(text), now)]);
  thread.set("comments", comments);
  thread.set("resolved", false);
  thread.set("resolvedUpdatedAt", undefined);
  thread.set("resolvedBy", undefined);
  thread.set("metadata", meta);
  threads.set(id, thread);
  return id;
}

export function addThreadComment(threads: Y.Map<any>, threadId: string, userId: string, text: string) {
  const thread = threads.get(threadId) as Y.Map<any> | undefined;
  if (!thread) throw new Error("Thread not found");
  const now = Date.now();
  (thread.get("comments") as Y.Array<Y.Map<any>>).push([commentMap(userId, textCommentBody(text), now)]);
  thread.set("updatedAt", now);
}

export function updateThreadMeta(threads: Y.Map<any>, threadId: string, patch: Partial<ThreadMeta>) {
  const thread = threads.get(threadId) as Y.Map<any> | undefined;
  if (!thread) return;
  const meta = { ...((thread.get("metadata") as ThreadMeta | undefined) ?? {}), ...patch };
  thread.set("metadata", meta);
  if (patch.status === "resolved") {
    thread.set("resolved", true);
    thread.set("resolvedUpdatedAt", Date.now());
  } else if (patch.status && thread.get("resolved")) {
    thread.set("resolved", false);
    thread.set("resolvedUpdatedAt", Date.now());
  }
}

/**
 * The AI persona a thread is waiting on: the thread's persona when the author
 * assigned it to the AI, or the persona the latest author comment @mentions.
 */
export function aiTargetOf(thread: ThreadSnapshot): Persona | null {
  if (thread.resolved || thread.meta.status === "resolved" || thread.meta.status === "in-progress") return null;
  if (thread.meta.assignee === "ai") return personaById(thread.meta.agent ?? DEFAULT_PERSONA_ID);
  const last = [...thread.comments].reverse().find((comment) => !comment.deleted);
  if (!last || isAIUser(last.userId)) return null;
  return mentionedPersona(last.text);
}

export function threadWantsAI(thread: ThreadSnapshot) {
  return aiTargetOf(thread) !== null;
}

/** Identifies one request to the AI, so each is processed once. */
export function aiRequestKey(thread: ThreadSnapshot) {
  const last = [...thread.comments].reverse().find((comment) => !comment.deleted);
  return `${thread.id}:${last?.id ?? ""}:${thread.meta.requestedAt ?? ""}`;
}
