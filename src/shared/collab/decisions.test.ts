import { expect, test } from "bun:test";
import * as Y from "yjs";
import { COLLAB_THREADS_MAP } from "./protocol";
import { AI_USER_ID, createThread, readThreads, updateThreadMeta } from "./threads";
import { answerDecision, answerDecisionsTogether, dismissDecision, openDecisions } from "./decisions";
import { setEditLevel, WRITING_MAP } from "./writing";

function setup() {
  const ydoc = new Y.Doc();
  const map = ydoc.getMap(COLLAB_THREADS_MAP);
  const a = createThread(map, AI_USER_ID, "Qualify the claim.", { assignee: "me", manual: true, decision: { question: "Which endpoint?", askedAt: 2 } });
  const b = createThread(map, "me", "Shorten this.", { assignee: "me", manual: true, decision: { question: "Which part may go?", askedAt: 1 } });
  createThread(map, "me", "No question.", { assignee: "me" });
  const thread = (id: string) => readThreads(map).find(item => item.id === id)!;
  return { ydoc, map, a, b, thread };
}

test("the queue holds open questions, oldest first", () => {
  const { map, a, b } = setup();
  expect(openDecisions(readThreads(map)).map(thread => thread.id)).toEqual([b, a]);
  updateThreadMeta(map, a, { status: "resolved" });
  expect(openDecisions(readThreads(map)).map(thread => thread.id)).toEqual([b]);
});

test("answering hands the thread back to the AI with the answer", () => {
  const { ydoc, a, thread } = setup();
  expect(() => answerDecision(ydoc, a, "  ")).toThrow("Write an answer first.");
  answerDecision(ydoc, a, "The primary endpoint.");
  expect(thread(a).comments.at(-1)).toMatchObject({ userId: "me", text: "The primary endpoint." });
  expect(thread(a).meta).toMatchObject({ assignee: "ai", status: "open" });
  expect(thread(a).meta.decision).toBeUndefined();
  expect(thread(a).meta.manual).toBeUndefined();
});

test("answers sent together start one coordinated revision at the document's edit level", () => {
  const { ydoc, map, a, b, thread } = setup();
  ydoc.transact(() => setEditLevel(ydoc.getMap(WRITING_MAP), "proofread"));
  const request = answerDecisionsTogether(ydoc, new Map([[a, "Primary."], [b, ""]]));
  expect(thread(a).comments.at(-1)?.text).toBe("Primary.");
  expect(thread(a).meta.bulkRequestId).toBe(request);
  expect(thread(b).meta.decision).toBeDefined(); // Unanswered questions stay in the queue.
  expect(readThreads(map).find(item => item.id === request)?.meta).toMatchObject({ documentAction: "resolve-comments", editLevel: "proofread" });
});

test("nothing is posted while an AI task runs, and dismissing keeps the thread with the author", () => {
  const { ydoc, map, a, b, thread } = setup();
  createThread(map, "me", "Running", { assignee: "ai", status: "in-progress" });
  expect(() => answerDecisionsTogether(ydoc, new Map([[a, "Primary."]]))).toThrow("Wait for the current AI task");
  expect(thread(a).comments).toHaveLength(1);
  dismissDecision(ydoc, b);
  expect(thread(b).meta).toMatchObject({ assignee: "me", manual: true });
  expect(thread(b).meta.decision).toBeUndefined();
});
