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
const { createThread, readThreads } = await import("../../../shared/collab/threads");
const { mentionedPersona } = await import("../../../shared/collab/personas");

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

test("a thread addressed to @stats is answered by the statistics reviewer, with its own cursor", async () => {
  let presence: string[] = [];
  let system = "";
  const session = await setup(async (messages, s) => {
    system = messages[0].content as string;
    presence = [...s.awareness.getStates().entries()]
      .filter(([clientId]: [number]) => clientId !== s.ydoc.clientID)
      .map(([, state]: [number, any]) => state?.user?.name);
    const passage = (messages[1].content as string).match(/<passage_to_edit>\n([\s\S]*?)\n<\/passage_to_edit>/)![1];
    return `<reply>Report the effect size.</reply><passage>${passage.replace("proving a large effect", "a difference whose size is not yet reported")}</passage>`;
  });
  let id = "";
  session.ydoc.transact(() => { id = createThread(session.ydoc.getMap(COLLAB_THREADS_MAP), "me", "@stats is this right?", {}); }, "editor");
  anchorThread(session, "r1", id, "editor");
  await new Promise((r) => setTimeout(r, 300));
  await settled();

  const thread = threads(session).find((t) => t.id === id)!;
  expect(thread.comments[1].userId).toBe("scholarpen-stats");
  expect(thread.meta.agent).toBe("stats-reviewer");
  expect(system).toContain("biostatistician");
  // Its cursor was a separate collaborator, and the agent did not wait on it.
  expect(presence).toContain("Statistics reviewer · editing");
  expect([...session.awareness.getStates().values()].some((state: any) => state?.user)).toBe(false);
});

test("Reviewer 2 reviews with its own focus and posts as itself", async () => {
  let system = "";
  const session = await setup(async (messages) => {
    system = messages[0].content as string;
    return JSON.stringify({ findings: [
      { paragraph: 1, quote: "proving a large effect", category: "generalisation", severity: "high", comment: "Single p-value; the conclusion goes beyond the data." },
    ] });
  });
  reviewer.reviewSection(session.docKey, "r1", "manual", "reviewer-2");
  await settled();
  const posted = threads(session);
  expect(posted).toHaveLength(1);
  expect(posted[0].comments[0].userId).toBe("scholarpen-reviewer2");
  expect(posted[0].meta).toMatchObject({ agent: "reviewer-2", category: "generalisation" });
  expect(system).toContain("Reviewer 2");
  expect(system).toContain("skeptical journal referee");
});

test("mentions pick the persona", () => {
  expect(mentionedPersona("@AI please")?.id).toBe("scholarpen-ai");
  expect(mentionedPersona("@ai then @Reviewer2 should weigh in")?.id).toBe("reviewer-2");
  expect(mentionedPersona("mail me at x@ai.com")).toBeNull();
});
