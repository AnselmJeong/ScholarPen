import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { EditorState } from "prosemirror-state";
import type { OllamaMessage } from "../../../shared/rpc-types";
import type { CollabSession } from "../registry";

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
const { anchorThread, readDoc, findBlock, blockContent, writeBlock, threadRange } = await import("./doc-model");
const { schemaToSpecJSON } = await import("../../../shared/collab/schema-spec");
const { COLLAB_THREADS_MAP } = await import("../../../shared/collab/protocol");
const { createThread, readThreads, updateThreadMeta, AI_USER_ID } = await import("../../../shared/collab/threads");
const { REVIEW_MAP, PROJECT_REVIEW_SETTINGS_KEY, REVIEW_CATEGORIES } = await import("../../../shared/collab/review");

const editor = getHeadlessEditor();
const schemaSpec = schemaToSpecJSON(editor.pmSchema);
const BLOCKS = [
  { id: "h1", type: "heading", props: { level: 1 }, content: "Results" },
  { id: "p1", type: "paragraph", content: "Our findings prove that the treatment works in every patient." },
  { id: "p2", type: "paragraph", content: [
    { type: "text", text: "Prior work agrees ", styles: {} },
    { type: "citation", props: { citekey: "ghost2019", locator: "" } },
    { type: "text", text: ".", styles: {} },
  ] },
  { id: "h2", type: "heading", props: { level: 1 }, content: "Discussion" },
  { id: "p3", type: "paragraph", content: "This is a separate section." },
];

let registry: InstanceType<typeof CollabRegistry>;
let agent: InstanceType<typeof CollabAgent>;
let reviewer: InstanceType<typeof Reviewer>;
afterEach(async () => {
  reviewer?.dispose();
  agent?.dispose();
  await registry?.dispose();
});

async function setup(complete: (messages: OllamaMessage[]) => Promise<string>, clock = { now: Date.now() }, blocks = BLOCKS, saved?: Uint8Array) {
  const seeded = blocksToYDoc(editor, blocks as any, "document-store");
  registry = new CollabRegistry({
    read: async () => ({ state: saved ?? Y.encodeStateAsUpdate(seeded), meta: { jsonHash: "h", updatedAt: 0 } }),
    write: async () => {},
    jsonHash: async () => "h",
  }, { update: () => {}, awareness: () => {} });
  await registry.open({ projectPath: "/p", filename: "doc.scholarpen.json", peerId: "editor", schema: schemaSpec });
  const session = registry.get("/p::doc.scholarpen.json")!;
  const prompts: OllamaMessage[][] = [];
  const respond = async (messages: OllamaMessage[]) => { prompts.push(messages); return complete(messages); };
  agent = new CollabAgent(registry, { complete: respond, onActivity: () => {}, pollMs: 5, waitForAuthorMs: 50, now: () => clock.now });
  reviewer = new Reviewer(agent, {
    complete: respond,
    citekeys: async () => new Set(["real2020"]),
    now: () => clock.now,
    tickMs: 0,
  });
  return { session, prompts };
}

const findings = (items: unknown[]) => async () => JSON.stringify({ findings: items });
const threads = (session: any) => readThreads(session.ydoc.getMap(COLLAB_THREADS_MAP));

async function idle() {
  for (let i = 0; i < 100 && agent.isBusy("/p::doc.scholarpen.json"); i++) await new Promise((r) => setTimeout(r, 10));
}

test("a section review posts anchored AI threads and respects severity", async () => {
  const { session, prompts } = await setup(findings([
    { paragraph: 1, quote: "prove that the treatment works in every patient", category: "overclaim", severity: "high", comment: "This overstates the evidence." },
    { paragraph: 1, quote: "Our findings", category: "definition", severity: "low", comment: "Minor point." },
    { paragraph: 2, quote: "not in the text", category: "logic", severity: "medium", comment: "Unclear link." },
  ]));
  session.ydoc.getMap(REVIEW_MAP).set("minSeverity", "medium");
  reviewer.reviewSection(session.docKey, "p1");
  await idle();

  // Only the Results section was sent.
  const reviewed = (prompts[0][1].content as string).split("<rest_of_manuscript")[0];
  expect(reviewed).toContain('<section title="Results">');
  expect(reviewed).toContain('<paragraph n="1">\nOur findings prove');
  expect(reviewed).not.toContain("separate section");

  const posted = threads(session);
  expect(posted.map((t) => t.meta.category).sort()).toEqual(["citation", "logic", "overclaim"]);
  expect(posted.every((t) => t.comments[0].userId === AI_USER_ID && t.meta.assignee === "me")).toBe(true);
  expect(posted.find((t) => t.meta.category === "citation")!.comments[0].text).toContain("@ghost2019 is not in references.bib");

  // The overclaim is anchored to the quoted words; the unmatched quote falls back to its paragraph.
  const doc = readDoc(session);
  const overclaim = posted.find((t) => t.meta.category === "overclaim")!;
  const range = threadRange(doc, overclaim.id)!;
  expect(doc.textBetween(range.from, range.to)).toBe("prove that the treatment works in every patient");
  const logic = posted.find((t) => t.meta.category === "logic")!;
  expect(threadRange(doc, logic.id)).not.toBeNull();

  // Reviewing again posts nothing new: duplicate findings are still suppressed.
  reviewer.reviewSection(session.docKey, "p1");
  await idle();
  expect(threads(session)).toHaveLength(3);
});

test("muted categories and resolved findings are not raised again", async () => {
  const { session } = await setup(findings([
    { paragraph: 1, quote: "prove that the treatment works", category: "overclaim", severity: "high", comment: "Too strong." },
  ]));
  session.ydoc.getMap(REVIEW_MAP).set("muted", ["citation"]);
  reviewer.reviewSection(session.docKey, "p1");
  await idle();
  expect(threads(session).map((t) => t.meta.category)).toEqual(["overclaim"]);

  const map = session.ydoc.getMap(COLLAB_THREADS_MAP);
  session.ydoc.transact(() => updateThreadMeta(map, threads(session)[0].id, { status: "resolved" }), "editor");
  reviewer.reviewSection(session.docKey, "p1");
  await idle();
  expect(threads(session)).toHaveLength(1);
});

function authorEdit(session: CollabSession, blockId: string) {
  const doc = readDoc(session);
  const block = findBlock(doc, blockId)!;
  const content = blockContent(block);
  const state = EditorState.create({ schema: session.schema, doc });
  writeBlock(session, state.tr.insertText(" More.", content.to).doc.nodeAt(block.pos)!, "editor");
}

function reviewedTarget(messages: OllamaMessage[]) {
  return String(messages[1].content).split("<rest_of_manuscript")[0];
}

test("automatically reviews untouched sections, then stops until content or preferences change", async () => {
  const clock = { now: 1_000_000 };
  const { session, prompts } = await setup(findings([]), clock);
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(1);
  expect(reviewedTarget(prompts[0])).toContain('title="Results"');

  clock.now += 20_000;
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(2);
  expect(reviewedTarget(prompts[1])).toContain('title="Discussion"');

  clock.now += 20_000;
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(2);
  expect(session.ydoc.getMap(REVIEW_MAP).get("progress")).toEqual({ reviewedSections: 2, totalSections: 2 });

  authorEdit(session, "p1");
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(3);
  expect(reviewedTarget(prompts[2])).toContain(" More.");
});

test("the author can hand an AI finding back to the AI to fix", async () => {
  let step = 0;
  const { session } = await setup(async (messages) => {
    step++;
    if (step === 1) return JSON.stringify({ findings: [
      { paragraph: 1, quote: "prove that the treatment works in every patient", category: "overclaim", severity: "high", comment: "Overstated." },
    ] });
    const passage = (messages[1].content as string).match(/<passage_to_edit>\n([\s\S]*?)\n<\/passage_to_edit>/)![1];
    expect(messages[1].content).toContain("Overstated.");
    return `<reply>Hedged.</reply><passage>${passage.replace("prove that the treatment works in every patient", "suggest the treatment helps many patients")}</passage>`;
  });
  session.ydoc.getMap(REVIEW_MAP).set("muted", ["citation"]);
  reviewer.reviewSection(session.docKey, "p1");
  await idle();
  const finding = threads(session)[0];
  session.ydoc.transact(() => updateThreadMeta(session.ydoc.getMap(COLLAB_THREADS_MAP), finding.id,
    { assignee: "ai", status: "open", requestedAt: Date.now() }), "editor");
  for (let i = 0; i < 100 && threads(session)[0].comments.length < 2; i++) await new Promise((r) => setTimeout(r, 10));

  expect(threads(session)[0].comments[1].text).toContain("Hedged.");
  let inserted = "";
  blockContent(findBlock(readDoc(session), "p1")!).node.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === "insertion")) inserted += node.text;
    return true;
  });
  expect(inserted).toContain("suggest");
});


test("repeated opening edits do not starve the tail, even across a restart", async () => {
  const clock = { now: 1_000_000 };
  let { session, prompts } = await setup(findings([]), clock);
  reviewer.tick();
  await idle();
  authorEdit(session, "p1");
  const saved = Y.encodeStateAsUpdate(session.ydoc);
  reviewer.dispose();
  agent.dispose();
  await registry.dispose();
  ({ session, prompts } = await setup(findings([]), clock, BLOCKS, saved));
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(1);
  expect(reviewedTarget(prompts[0])).toContain('title="Discussion"');
  clock.now += 20_000;
  reviewer.tick();
  await idle();
  expect(reviewedTarget(prompts[1])).toContain('title="Results"');
});

test("a failing opening section does not block reviewing later sections", async () => {
  const clock = { now: 1_000_000 };
  const { session, prompts } = await setup(async (messages) => {
    if (reviewedTarget(messages).includes('title="Results"')) throw new Error("Model unavailable");
    return '{"findings":[]}';
  }, clock);
  reviewer.tick();
  await idle();
  clock.now += 20_000;
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(2);
  expect(reviewedTarget(prompts[1])).toContain('title="Discussion"');
  expect(agent.jobs(session.docKey).some(job => job.state === "failed")).toBe(true);
});

test("long sections send every paragraph in batches and post more than three comments", async () => {
  const blocks = [BLOCKS[0], ...Array.from({ length: 20 }, (_, i) => ({
    id: `long-${i}`, type: "paragraph", content: `Passage ${i}. A claim requiring scrutiny.`,
  }))];
  const { session, prompts } = await setup(async (messages) => {
    const target = reviewedTarget(messages);
    return JSON.stringify({ findings: [...target.matchAll(/<paragraph n="(\d+)">\n(Passage \d+)/g)].map(match => ({
      paragraph: Number(match[1]), quote: match[2], category: "logic", severity: "medium", comment: `Check ${match[2]}.`,
    })) });
  }, undefined, blocks);
  session.ydoc.getMap(REVIEW_MAP).set("minSeverity", "medium");
  reviewer.reviewSection(session.docKey, "long-0");
  await idle();
  expect(prompts).toHaveLength(3);
  expect(threads(session)).toHaveLength(20);
  expect(threads(session).some(thread => thread.meta.blockId === "long-19")).toBe(true);
  expect(prompts.every(messages => String(messages[0].content).includes("at most 10 findings"))).toBe(true);
  // All comments remain anchored to the actual reviewed paragraphs.
  for (const thread of threads(session)) expect(threadRange(readDoc(session), thread.id)).not.toBeNull();
  reviewer.reviewSection(session.docKey, "long-0");
  await idle();
  expect(threads(session)).toHaveLength(20);
});

test("bibliography findings cannot crowd out a later substantive comment", async () => {
  const blocks = [BLOCKS[0], ...Array.from({ length: 5 }, (_, i) => ({
    id: `cite-${i}`, type: "paragraph", content: [
      { type: "text", text: `Claim ${i} `, styles: {} },
      { type: "citation", props: { citekey: `absent${i}`, locator: "" } },
    ],
  }))];
  const { session } = await setup(findings([
    { paragraph: 5, quote: "Claim 4", category: "logic", severity: "high", comment: "The final argument needs support." },
  ]), undefined, blocks);
  reviewer.reviewSection(session.docKey, "cite-0");
  await idle();
  expect(threads(session)).toHaveLength(6);
  expect(threads(session).filter(thread => thread.meta.category === "citation")).toHaveLength(5);
  expect(threads(session).find(thread => thread.meta.category === "logic")?.meta.blockId).toBe("cite-4");
});

test("distinct issues of the same category in one paragraph are allowed", async () => {
  const { session } = await setup(findings([
    { paragraph: 1, quote: "Our findings", category: "logic", severity: "high", comment: "First issue." },
    { paragraph: 1, quote: "every patient", category: "logic", severity: "high", comment: "Second issue." },
  ]));
  reviewer.reviewSection(session.docKey, "p1");
  await idle();
  expect(threads(session).filter(thread => thread.meta.category === "logic")).toHaveLength(2);
});

test("edits during inference are not marked as reviewed or given stale comments", async () => {
  const clock = { now: 1_000_000 };
  let respond: (value: string) => void = () => {};
  const { session, prompts } = await setup(() => new Promise<string>(resolve => { respond = resolve; }), clock);
  reviewer.reviewSection(session.docKey, "p1");
  for (let i = 0; i < 50 && !prompts.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  authorEdit(session, "p1");
  respond(JSON.stringify({ findings: [
    { paragraph: 1, quote: "Our findings", category: "logic", severity: "high", comment: "Stale comment." },
  ] }));
  await idle();
  expect(threads(session).some(thread => thread.meta.category === "logic")).toBe(false);
  reviewer.tick();
  expect(session.ydoc.getMap(REVIEW_MAP).get("progress")).toEqual({ reviewedSections: 0, totalSections: 2 });
  for (let i = 0; i < 50 && prompts.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  respond('{"findings":[]}');
  await idle();
});

test("unmuting or lowering the threshold reconsiders unchanged content", async () => {
  const clock = { now: 1_000_000 };
  const { session, prompts } = await setup(findings([
    { paragraph: 1, quote: "Our findings", category: "logic", severity: "low", comment: "Check this connection." },
  ]), clock, BLOCKS.slice(0, 2));
  const map = session.ydoc.getMap(REVIEW_MAP);
  map.set("muted", ["logic"]);
  reviewer.tick();
  await idle();
  expect(threads(session)).toHaveLength(0);
  map.set("muted", []);
  map.set("minSeverity", "low");
  clock.now += 20_000;
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(2);
  expect(threads(session)).toHaveLength(1);
});

test("pause and auto-review off stop background calls; heading-only sections are skipped", async () => {
  const { session, prompts } = await setup(findings([]), undefined, [BLOCKS[0], BLOCKS[3], BLOCKS[4]]);
  session.ydoc.getMap(REVIEW_MAP).set("autoReview", false);
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(0);
  session.ydoc.getMap(REVIEW_MAP).set("autoReview", true);
  agent.setPaused(true);
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(0);
  agent.setPaused(false);
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(1);
  expect(reviewedTarget(prompts[0])).toContain('title="Discussion"');
  expect(session.ydoc.getMap(REVIEW_MAP).get("progress")).toEqual({ reviewedSections: 0, totalSections: 1 });
});


test("an invalid model response is a failed review, never a clean bill of health", async () => {
  const { session } = await setup(async () => '{"message":"Unable to review"}');
  reviewer.tick();
  await idle();
  expect(agent.jobs(session.docKey)[0].state).toBe("failed");
  expect(session.ydoc.getMap(REVIEW_MAP).get("sections")).toBeUndefined();
});

test("legacy review completion is revisited once under the expanded review policy", async () => {
  const clock = { now: 1_000_000 };
  const { session, prompts } = await setup(findings([]), clock, BLOCKS.slice(0, 2));
  reviewer.tick();
  await idle();
  const map = session.ydoc.getMap(REVIEW_MAP);
  const sections = map.get("sections") as Record<string, Record<string, unknown>>;
  const { version, settings, ...legacy } = sections.h1;
  map.set("sections", { h1: legacy });
  clock.now += 20_000;
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(2);
  clock.now += 20_000;
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(2);
});

test("turning off auto-review during inference prevents new automatic comments", async () => {
  let stop: () => void = () => {};
  const { session } = await setup(async () => {
    stop();
    return JSON.stringify({ findings: [
      { paragraph: 1, quote: "Our findings", category: "logic", severity: "high", comment: "Cancelled comment." },
    ] });
  });
  stop = () => session.ydoc.getMap(REVIEW_MAP).set("autoReview", false);
  reviewer.tick();
  await idle();
  expect(threads(session)).toHaveLength(0);
  expect(session.ydoc.getMap(REVIEW_MAP).get("sections")).toBeUndefined();
});


test("project-disabled categories and unknown model types cannot become comments", async () => {
  const { session, prompts } = await setup(findings([
    { paragraph: 1, quote: "Our findings", category: "invented-kind", severity: "high", comment: "Unrecognized." },
    { paragraph: 1, quote: "Our findings", category: "Needs citation", severity: "high", comment: "Disabled citation alias." },
    { paragraph: 1, quote: "every patient", category: "logic", severity: "high", comment: "Enabled logic." },
  ]));
  session.ydoc.getMap(REVIEW_MAP).set(PROJECT_REVIEW_SETTINGS_KEY, { disabledCategories: ["citation"] });
  reviewer.reviewSection(session.docKey, "p1");
  await idle();
  expect(threads(session).map(t => t.meta.category)).toEqual(["logic"]);
  expect(String(prompts[0][0].content).split('"category":"')[1].split('"')[0]).not.toContain("citation");
});

test("disabling a project type during inference filters the in-flight response too", async () => {
  let disable: () => void = () => {};
  const { session } = await setup(async () => {
    disable();
    return JSON.stringify({ findings: [
      { paragraph: 1, quote: "Our findings", category: "logic", severity: "high", comment: "Disabled while working." },
    ] });
  });
  disable = () => session.ydoc.getMap(REVIEW_MAP).set(PROJECT_REVIEW_SETTINGS_KEY, { disabledCategories: ["logic", "citation"] });
  reviewer.reviewSection(session.docKey, "p1");
  await idle();
  expect(threads(session)).toHaveLength(0);
});

test("all project types off causes no model requests, even for a manual review", async () => {
  const { session, prompts } = await setup(findings([]));
  session.ydoc.getMap(REVIEW_MAP).set(PROJECT_REVIEW_SETTINGS_KEY, { disabledCategories: REVIEW_CATEGORIES.map(c => c.id) });
  reviewer.tick();
  await idle();
  reviewer.reviewSection(session.docKey, "p1");
  await idle();
  expect(prompts).toHaveLength(0);
  expect(threads(session)).toHaveLength(0);
});

test("a resolved legacy Needs citation finding stays deduplicated after category merging", async () => {
  const { session } = await setup(findings([
    { paragraph: 1, quote: "Our findings", category: "missing-citation", severity: "high", comment: "Needs a source." },
  ]));
  reviewer.reviewSection(session.docKey, "p1");
  await idle();
  const map = session.ydoc.getMap(COLLAB_THREADS_MAP);
  const citation = threads(session).find(t => t.comments[0].text === "Needs a source.")!;
  expect(citation.meta.category).toBe("citation");
  updateThreadMeta(map, citation.id, {
    status: "resolved", category: "missing-citation",
    fingerprint: citation.meta.fingerprint!.replace(":citation:", ":missing-citation:"),
  });
  reviewer.reviewSection(session.docKey, "p1");
  await idle();
  expect(threads(session).filter(t => t.comments[0].text === "Needs a source.")).toHaveLength(1);
});

test("resolving and editing a paragraph does not restart its section; other paragraphs remain reviewable", async () => {
  const clock = { now: 1_000_000 };
  const { session, prompts } = await setup(findings([
    { paragraph: 1, quote: "Our findings", category: "logic", severity: "high", comment: "Check the logic." },
  ]), clock, BLOCKS.slice(0, 3));
  reviewer.tick();
  await idle();
  const map = session.ydoc.getMap(COLLAB_THREADS_MAP);
  const finding = threads(session).find(t => t.meta.blockId === "p1")!;
  updateThreadMeta(map, finding.id, { status: "resolved" });
  authorEdit(session, "p1");
  clock.now += 20_000;
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(1);
  expect(session.ydoc.getMap(REVIEW_MAP).get("progress")).toEqual({ reviewedSections: 1, totalSections: 1 });

  authorEdit(session, "p2");
  clock.now += 20_000;
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(2);
  expect(reviewedTarget(prompts[1])).toContain("Prior work agrees");
  // Resolved text is excluded even from the reference context, not just posting.
  expect(String(prompts[1][1].content)).not.toContain("Our findings");
});

test("manual review revisits resolved paragraphs once without re-enabling automatic scans", async () => {
  const clock = { now: 1_000_000 };
  let call = 0;
  const { session, prompts } = await setup(async () => JSON.stringify({ findings: [
    { paragraph: 1, quote: ++call === 1 ? "Our findings" : "every patient", category: "logic", severity: "high", comment: `Issue ${call}.` },
  ] }), clock, BLOCKS.slice(0, 2));
  reviewer.tick();
  await idle();
  updateThreadMeta(session.ydoc.getMap(COLLAB_THREADS_MAP), threads(session)[0].id, { status: "resolved" });
  reviewer.reviewSection(session.docKey, "p1");
  await idle();
  expect(prompts).toHaveLength(2);
  expect(threads(session)).toHaveLength(2);
  expect(reviewedTarget(prompts[1])).toContain("Our findings");
  authorEdit(session, "p1");
  session.ydoc.getMap(REVIEW_MAP).set("minSeverity", "low");
  clock.now += 20_000;
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(2);
});

test("native thread resolution remains excluded after reopening, deleting the thread, and restarting", async () => {
  const clock = { now: 1_000_000 };
  let { session, prompts } = await setup(findings([
    { paragraph: 1, quote: "Our findings", category: "logic", severity: "high", comment: "Check this." },
  ]), clock, BLOCKS.slice(0, 2));
  reviewer.tick();
  await idle();
  const map = session.ydoc.getMap<InstanceType<typeof Y.Map>>(COLLAB_THREADS_MAP);
  const id = threads(session)[0].id;
  // BlockNote's native resolve changes the raw flag without ScholarPen metadata.
  map.get(id)!.set("resolved", true);
  map.get(id)!.set("resolved", false);
  map.delete(id);
  authorEdit(session, "p1");
  const saved = Y.encodeStateAsUpdate(session.ydoc);
  reviewer.dispose();
  agent.dispose();
  await registry.dispose();
  ({ session, prompts } = await setup(findings([]), clock, BLOCKS.slice(0, 2), saved));
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(0);
  expect(session.ydoc.getMap(REVIEW_MAP).get("progress")).toEqual({ reviewedSections: 1, totalSections: 1 });
});

test("older resolved AI comments are backfilled, while resolved human comments do not suppress review", async () => {
  let { session, prompts } = await setup(findings([]), undefined, BLOCKS.slice(0, 3));
  reviewer.dispose();
  agent.dispose();
  const map = session.ydoc.getMap(COLLAB_THREADS_MAP);
  const aiId = createThread(map, "scholarpen-reviewer2", "Old review.", { blockId: "p1" });
  (map.get(aiId) as InstanceType<typeof Y.Map>).set("resolved", true);
  const humanId = createThread(map, "me", "My note.", { blockId: "p2", manual: true });
  updateThreadMeta(map, humanId, { status: "resolved" });
  const saved = Y.encodeStateAsUpdate(session.ydoc);
  await registry.dispose();
  ({ session, prompts } = await setup(findings([]), undefined, BLOCKS.slice(0, 3), saved));
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(1);
  expect(String(prompts[0][1].content)).not.toContain("Our findings");
  expect(reviewedTarget(prompts[0])).toContain("Prior work agrees");
  expect(threads(session).some(t => t.meta.blockId === "p2" && t.meta.category === "citation")).toBe(true);
});

test("resolution during inference discards new model issues and pending bibliography findings", async () => {
  let resolveDuringInference = () => {};
  const { session } = await setup(async () => {
    resolveDuringInference();
    return JSON.stringify({ findings: [
      { paragraph: 1, quote: "every patient", category: "overclaim", severity: "high", comment: "A different issue." },
    ] });
  }, undefined, BLOCKS.slice(0, 3));
  const map = session.ydoc.getMap(COLLAB_THREADS_MAP);
  const ids = ["p1", "p2"].map(blockId => createThread(map, AI_USER_ID, "Existing review.", { blockId, assignee: "me" }));
  resolveDuringInference = () => {
    for (const id of ids) updateThreadMeta(map, id, { status: "resolved" });
  };
  reviewer.tick();
  await idle();
  expect(threads(session)).toHaveLength(2);
  expect(threads(session).every(t => t.resolved)).toBe(true);
});

test("later batches skip paragraphs resolved while an earlier batch was running", async () => {
  const blocks = [BLOCKS[0], ...Array.from({ length: 10 }, (_, i) => ({
    id: `batch-${i}`, type: "paragraph", content: `Passage ${i}. Review this claim.`,
  }))];
  let resolveDuringInference = () => {};
  const { session, prompts } = await setup(async () => {
    resolveDuringInference();
    return '{"findings":[]}';
  }, undefined, blocks);
  const map = session.ydoc.getMap(COLLAB_THREADS_MAP);
  const id = createThread(map, AI_USER_ID, "Earlier finding.", { blockId: "batch-8", assignee: "me" });
  resolveDuringInference = () => updateThreadMeta(map, id, { status: "resolved" });
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(2);
  expect(String(prompts[1][1].content)).not.toContain("Passage 8.");
  expect(reviewedTarget(prompts[1])).toContain("Passage 9.");
});

test("AI-resolved document edits exclude all fixed paragraphs without suppressing untouched sections", async () => {
  const { session, prompts } = await setup(findings([]));
  const map = session.ydoc.getMap(COLLAB_THREADS_MAP);
  const id = createThread(map, "me", "Fix these claims.", {
    agent: AI_USER_ID, scope: "document", editedBlockIds: ["p1", "p2"], assignee: "me",
  });
  session.ydoc.transact(() => updateThreadMeta(map, id, { status: "resolved" }), "ai-meta");
  authorEdit(session, "p1");
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(1);
  expect(reviewedTarget(prompts[0])).toContain("This is a separate section");
  expect(String(prompts[0][1].content)).not.toContain("Our findings");
  expect(String(prompts[0][1].content)).not.toContain("Prior work agrees");
  // The missing bibliography entry in the resolved paragraph is not raised either.
  expect(threads(session)).toHaveLength(1);
});

test("legacy AI-assisted passage threads can retire paragraphs using their comment anchor", async () => {
  const { session, prompts } = await setup(findings([]), undefined, BLOCKS.slice(0, 2));
  const map = session.ydoc.getMap(COLLAB_THREADS_MAP);
  const id = createThread(map, AI_USER_ID, "Fixed this passage.", { assignee: "me" });
  anchorThread(session, "p1", id, "ai-meta");
  updateThreadMeta(map, id, { status: "resolved" });
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(0);
  expect(session.ydoc.getMap(REVIEW_MAP).get("progress")).toEqual({ reviewedSections: 1, totalSections: 1 });
});

test("default review posts only serious findings and tells the model to omit optional improvements", async () => {
  const { session, prompts } = await setup(findings([
    { paragraph: 1, quote: "Our findings", category: "definition", severity: "low", comment: "Define findings." },
    { paragraph: 1, quote: "the treatment", category: "literature", severity: "medium", comment: "Add more background." },
    { paragraph: 1, quote: "every patient", category: "overclaim", severity: "high", comment: "The reported nonresponders contradict the claim of universal benefit; restrict the conclusion." },
    { paragraph: 1, quote: "prove", category: "logic", severity: "critical", comment: "Invalid severity." },
    { paragraph: 1, quote: "works", category: "logic", comment: "Missing severity." },
  ]), undefined, BLOCKS.slice(0, 2));
  reviewer.tick();
  await idle();
  expect(threads(session).map(t => t.meta.category)).toEqual(["overclaim"]);
  const prompt = String(prompts[0][0].content);
  expect(prompt).toContain("minimum severity is high");
  expect(prompt).toContain("never inflate their severity");
  expect(prompt).toContain("explain the material consequence");
  expect(prompt).toContain("Context is partial");
  expect(prompt).toContain("Without the cited source text");
  expect(prompt).toContain("zero findings is a successful review");
});

test("stricter settings do not restart completed reviews, including a legacy medium-default review", async () => {
  const clock = { now: 1_000_000 };
  const { session, prompts } = await setup(findings([
    { paragraph: 1, quote: "Our findings", category: "logic", severity: "medium", comment: "Existing feedback." },
  ]), clock, BLOCKS.slice(0, 2));
  const map = session.ydoc.getMap(REVIEW_MAP);
  map.set("minSeverity", "medium");
  reviewer.tick();
  await idle();
  expect(threads(session)).toHaveLength(1);
  // An old document stored the medium fingerprint but had no explicit preference.
  map.delete("minSeverity");
  map.set("muted", ["literature"]);
  clock.now += 20_000;
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(1);
  expect(map.get("progress")).toEqual({ reviewedSections: 1, totalSections: 1 });
  expect(threads(session)).toHaveLength(1); // Existing comments are preserved.
  expect(threads(session)[0].resolved).toBe(false);
  authorEdit(session, "p1");
  clock.now += 20_000;
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(2);
  expect(String(prompts[1][0].content)).toContain("minimum severity is high");
});

test("raising severity while the model is working filters the in-flight response", async () => {
  let raiseThreshold = () => {};
  const { session } = await setup(async () => {
    raiseThreshold();
    return JSON.stringify({ findings: [
      { paragraph: 1, quote: "Our findings", category: "logic", severity: "medium", comment: "No longer requested." },
      { paragraph: 1, quote: "every patient", category: "overclaim", severity: "high", comment: "Serious contradiction." },
    ] });
  }, undefined, BLOCKS.slice(0, 2));
  const map = session.ydoc.getMap(REVIEW_MAP);
  map.set("minSeverity", "medium");
  raiseThreshold = () => map.set("minSeverity", "high");
  reviewer.reviewSection(session.docKey, "p1");
  await idle();
  expect(threads(session).map(t => t.meta.severity)).toEqual(["high"]);
});
