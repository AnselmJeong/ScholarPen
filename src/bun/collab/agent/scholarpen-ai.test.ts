import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { OllamaMessage } from "../../../shared/rpc-types";

const dom = new Window();
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const globals = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "DocumentFragment", "MutationObserver", "DOMParser", "getComputedStyle"] as const;
const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom : Reflect.get(dom, key) });
afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.happyDOM.abort();
});

const { getHeadlessEditor } = await import("../../../renderer/collab/collab-peer");
const { blocksToYDoc } = await import("@blocknote/core/yjs");
const Y = await import("yjs");
const { CollabRegistry } = await import("../registry");
const { CollabAgent } = await import("./agent");
const { Reviewer } = await import("./reviewer");
const { anchorThread } = await import("./doc-model");
const { schemaToSpecJSON } = await import("../../../shared/collab/schema-spec");
const { COLLAB_THREADS_MAP } = await import("../../../shared/collab/protocol");
const { createThread, readThreads, threadWantsAI } = await import("../../../shared/collab/threads");
const { isAIUser, mentionedPersona } = await import("../../../shared/collab/personas");

const editor = getHeadlessEditor();
const BLOCKS = [
  { id: "h", type: "heading", props: { level: 1 }, content: "Results" },
  { id: "r1", type: "paragraph", content: "Group A improved more than group B (p = 0.04), proving a large effect." },
];

let registry: InstanceType<typeof CollabRegistry>;
let agent: InstanceType<typeof CollabAgent>;
let reviewer: InstanceType<typeof Reviewer>;
afterEach(async () => {
  reviewer?.dispose();
  agent?.dispose();
  await registry?.dispose();
});

async function setup(complete: (messages: OllamaMessage[], session: any) => Promise<string>) {
  const seeded = blocksToYDoc(editor, BLOCKS as any, "document-store");
  registry = new CollabRegistry({
    read: async () => ({ state: Y.encodeStateAsUpdate(seeded), meta: { jsonHash: "h", updatedAt: 0 } }),
    write: async () => {},
    jsonHash: async () => "h",
  }, { update: () => {}, awareness: () => {} });
  await registry.open({ projectPath: "/p", filename: "doc.scholarpen.json", peerId: "editor", schema: schemaToSpecJSON(editor.pmSchema) });
  const session = registry.get("/p::doc.scholarpen.json")!;
  const respond = async (messages: OllamaMessage[]) => complete(messages, session);
  agent = new CollabAgent(registry, { complete: respond, onActivity: () => {}, pollMs: 5, waitForAuthorMs: 2000 });
  reviewer = new Reviewer(agent, { complete: respond, citekeys: async () => new Set(), tickMs: 0 });
  return session;
}

const threads = (session: any) => readThreads(session.ydoc.getMap(COLLAB_THREADS_MAP));
async function settled() {
  for (let i = 0; i < 300 && agent.isBusy("/p::doc.scholarpen.json"); i++) await new Promise((r) => setTimeout(r, 10));
}

function thread(comments: Array<{ userId: string; text: string }>, meta: Record<string, unknown> = {}) {
  return {
    id: "t", createdAt: 0, updatedAt: 0, resolved: false, meta,
    comments: comments.map((comment, index) => ({ id: `c${index}`, createdAt: index, deleted: false, ...comment })),
  };
}

test("a comment saved for the AI is answered without a mention or an Ask", async () => {
  const session = await setup(async (messages) => {
    const passage = (messages[1].content as string).match(/<passage_to_edit>\n([\s\S]*?)\n<\/passage_to_edit>/)![1];
    return `<reply>Softened.</reply><passage>${passage.replace("proving a large effect", "suggesting an effect")}</passage>`;
  });
  let id = "";
  session.ydoc.transact(() => {
    id = createThread(session.ydoc.getMap(COLLAB_THREADS_MAP), "me", "too strong", { assignee: "ai", status: "open", requestedAt: Date.now() });
  }, "editor");
  anchorThread(session, "r1", id, "editor");
  await new Promise((r) => setTimeout(r, 300));
  await settled();

  const answered = threads(session).find((t) => t.id === id)!;
  expect(answered.comments[1]).toMatchObject({ userId: "scholarpen-ai", text: expect.stringContaining("Softened.") });
  expect(answered.meta).toMatchObject({ status: "proposed", assignee: "me" });
});

test("the author's reply in an AI thread goes back to the AI unless they took it over", () => {
  const conversation = [{ userId: "me", text: "too strong" }, { userId: "scholarpen-ai", text: "Softened." }];
  expect(threadWantsAI(thread(conversation, { assignee: "me", status: "proposed" }))).toBe(false);
  const replied = [...conversation, { userId: "me", text: "even softer" }];
  expect(threadWantsAI(thread(replied, { assignee: "me", status: "proposed" }))).toBe(true);
  expect(threadWantsAI(thread(replied, { assignee: "me", status: "open", manual: true }))).toBe(false);
  expect(threadWantsAI(thread(replied, { assignee: "me", status: "resolved" }))).toBe(false);
  // Threads from before auto-start that nobody assigned are left alone.
  expect(threadWantsAI(thread([{ userId: "me", text: "note to self" }]))).toBe(false);
});

test("the former statistics reviewer and Reviewer 2 now mean ScholarPen AI", async () => {
  expect(isAIUser("scholarpen-stats")).toBe(true);
  expect(isAIUser("scholarpen-reviewer2")).toBe(true);
  expect(threadWantsAI(thread([{ userId: "scholarpen-stats", text: "Report the effect size." }], { assignee: "me" }))).toBe(false);

  let system = "";
  const session = await setup(async (messages) => {
    system = messages[0].content as string;
    return JSON.stringify({ findings: [
      { paragraph: 1, quote: "proving a large effect", category: "statistics", severity: "high", comment: "Report the effect size." },
    ] });
  });
  reviewer.reviewSection(session.docKey, "r1", "manual");
  await settled();
  const posted = threads(session);
  expect(posted).toHaveLength(1);
  expect(posted[0].comments[0].userId).toBe("scholarpen-ai");
  expect(posted[0].meta).toMatchObject({ agent: "scholarpen-ai", category: "statistics" });
  // One reviewer covers what the three used to.
  expect(system).toContain("effect sizes");
  expect(system).toContain("skeptical journal referee");
});

test("mentions address ScholarPen AI, including the old handles", () => {
  expect(mentionedPersona("@AI please")?.id).toBe("scholarpen-ai");
  expect(mentionedPersona("@stats is this right?")?.id).toBe("scholarpen-ai");
  expect(mentionedPersona("@reviewer2 thoughts?")?.id).toBe("scholarpen-ai");
  expect(mentionedPersona("mail me at x@ai.com")).toBeNull();
});
