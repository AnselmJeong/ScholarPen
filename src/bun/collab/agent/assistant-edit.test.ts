import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { EditorState } from "prosemirror-state";
import type { AssistantEditChange } from "../../../shared/agent-document-edit";

// The webview's real schema builds realistic documents; the edit runs on Bun's render-less copy of it.
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
const { applySuggestions } = await import("@handlewithcare/prosemirror-suggest-changes");
const { CollabRegistry } = await import("../registry");
const { CollabAgent } = await import("./agent");
const { runAssistantEdit, assistantEditRules, locateChange } = await import("./assistant-edit");
const { readDoc, findBlock, blockContent, hasSuggestionMarks } = await import("./doc-model");
const { schemaToSpecJSON } = await import("../../../shared/collab/schema-spec");
const { COLLAB_THREADS_MAP, collabDocKey } = await import("../../../shared/collab/protocol");
const { CHANGE_SETS_MAP } = await import("../../../shared/collab/change-sets");
const { REVISIONS_MAP, readRevisions } = await import("../../../shared/collab/revision-log");
const { WRITING_MAP, setEditLevel } = await import("../../../shared/collab/writing");
const { ZONES_MAP } = await import("../../../shared/collab/zones");
const { listChangeSets } = await import("../../../renderer/collab/suggestions");

const editor = getHeadlessEditor();
const schemaSpec = schemaToSpecJSON(editor.pmSchema);

const BLOCKS = [
  { id: "h1-0000-methods", type: "heading", props: { level: 2 }, content: "Methods" },
  { id: "p1-0000-claim", type: "paragraph", content: "These results prove that the drug causes recovery in all patients." },
  { id: "p2-0000-cited", type: "paragraph", content: [
    { type: "text", text: "Earlier trials reported similar effects ", styles: {} },
    { type: "citation", props: { citekey: "smith2020", locator: "" } },
    { type: "text", text: " in small samples.", styles: {} },
  ] },
  { id: "p3-0000-model", type: "paragraph", content: [
    { type: "text", text: "We fitted a model yielding the coefficient ", styles: {} },
    { type: "text", text: "c", styles: { italic: true } },
    { type: "text", text: " for each predictor and defined ", styles: {} },
    { type: "inlineMath", props: { formula: "a \\times b" } },
    { type: "text", text: " as the indirect association. The fit was adequate.", styles: {} },
  ] },
  { id: "h2-0000-results", type: "heading", props: { level: 2 }, content: "Results" },
  { id: "p4-0000-result", type: "paragraph", content: "We recieve the data from three sites. The data from three sites were pooled." },
];

let registry: InstanceType<typeof CollabRegistry>;
let agent: InstanceType<typeof CollabAgent> | null = null;
afterEach(async () => {
  agent?.dispose();
  agent = null;
  await registry?.dispose();
});

async function setup(options: { filename?: string; observe?: string[] } = {}) {
  const seeded = blocksToYDoc(editor, BLOCKS as any, "document-store");
  registry = new CollabRegistry({
    read: async () => ({ state: Y.encodeStateAsUpdate(seeded), meta: { jsonHash: "h", updatedAt: 0 } }),
    write: async () => {},
    jsonHash: async () => "h",
  }, { update: () => {}, awareness: () => {} });
  const filename = options.filename ?? "paper.scholarpen.json";
  await registry.open({ projectPath: "/p", filename, peerId: "editor", schema: schemaSpec });
  const session = registry.get(collabDocKey("/p", filename))!;
  const calls: number[] = [];
  agent = new CollabAgent(registry, {
    complete: async () => { calls.push(1); throw new Error("The Assistant's edit must not call a model"); },
    onActivity: () => {},
    pollMs: 10,
    waitForAuthorMs: 100,
    editModeFor: (_session, blockId) => options.observe?.includes(blockId) ? "observe" : "auto",
  });
  return { session, calls, docKey: session.docKey };
}

const citekeys = async () => new Set(["smith2020", "lee2019"]);

function edit(docKey: string, changes: AssistantEditChange[], request = "Soften the claim in the first paragraph.") {
  return runAssistantEdit(agent!, { docKey, request, summary: "Softens the claim.", changes }, { citekeys });
}

/** A block's text once every pending suggestion is accepted (atoms as their preview). */
function acceptedText(session: any, blockId: string) {
  let doc = readDoc(session);
  applySuggestions(EditorState.create({ schema: session.schema, doc }), (tr) => { doc = tr.doc; });
  const content = blockContent(findBlock(doc, blockId)!);
  return doc.textBetween(content.from, content.to, "", (node) => node.type.name === "citation" ? `[@${node.attrs.citekey}]` : node.type.name === "inlineMath" ? `$${node.attrs.formula}$` : "");
}

function liveText(session: any, blockId: string) {
  return blockContent(findBlock(readDoc(session), blockId)!).node.textContent;
}

test("a reworded sentence lands as one tracked change set labelled for the Assistant, with no thread and no model call", async () => {
  const { session, calls, docKey } = await setup();
  const result = await edit(docKey, [{ paragraph: "p10000cl", old: "These results prove that", new: "These results suggest that" }]);

  expect(result).toMatchObject({ status: "applied", outcomes: [{ index: 0, applied: true, blockId: "p1-0000-claim" }] });
  expect(acceptedText(session, "p1-0000-claim")).toBe("These results suggest that the drug causes recovery in all patients.");
  // Review cards come from the change set: its suggestions, its label and the revision summary.
  const [set] = listChangeSets(readDoc(session), session.ydoc.getMap(CHANGE_SETS_MAP));
  expect(set.id).toBe(result.changeSetId!);
  expect(set.info).toMatchObject({ label: "Assistant: Soften the claim in the first paragraph.", persona: "scholarpen-ai" });
  const [revision] = readRevisions(session.ydoc.getMap(REVISIONS_MAP));
  expect(revision).toMatchObject({ id: result.revisionId, kind: "assistant", status: "pending", changeSetId: result.changeSetId, summary: "Softens the claim.", level: "sentence", items: [] });
  expect(revision.paragraphs).toEqual([{ blockId: "p1-0000-claim",
    before: "These results prove that the drug causes recovery in all patients.",
    after: "These results suggest that the drug causes recovery in all patients." }]);
  expect(session.ydoc.getMap(COLLAB_THREADS_MAP).size).toBe(0);
  expect(calls).toHaveLength(0);
  expect(agent!.jobs(docKey)[0]).toMatchObject({ kind: "assistant", label: "Assistant: Soften the claim in the first paragraph.", state: "done" });
  // The edit is an AI edit: "Undo last AI edit" takes it back.
  expect(agent!.undoLast(docKey)).toBe(true);
  expect(hasSuggestionMarks(readDoc(session))).toBe(false);
  expect(liveText(session, "p1-0000-claim")).toBe("These results prove that the drug causes recovery in all patients.");
});

test("several changes across paragraphs share one change set; citations, math and formatting runs stay", async () => {
  const { session, docKey } = await setup();
  const result = await edit(docKey, [
    { paragraph: "p20000ci", old: "similar effects [@smith2020] in small samples", new: "comparable effects [@smith2020] in small cohorts" },
    { paragraph: "p30000mo", old: "defined $a \\times b$ as the indirect association", new: "took $a \\times b$ as the model-based indirect association" },
    { paragraph: "p30000mo", old: "The fit was adequate.", new: "" },
  ]);
  expect(result.status).toBe("applied");
  expect(result.outcomes.every((outcome) => outcome.applied)).toBe(true);
  expect(acceptedText(session, "p2-0000-cited")).toBe("Earlier trials reported comparable effects [@smith2020] in small cohorts.");
  expect(acceptedText(session, "p3-0000-model"))
    .toBe("We fitted a model yielding the coefficient c for each predictor and took $a \\times b$ as the model-based indirect association.");
  const sets = listChangeSets(readDoc(session), session.ydoc.getMap(CHANGE_SETS_MAP));
  expect(sets).toHaveLength(1);
  expect(sets[0].paragraphs.map((paragraph) => paragraph.blockId)).toEqual(["p2-0000-cited", "p3-0000-model"]);
  // The italic run and the atoms are still there, untouched.
  let italic = "";
  let atoms = 0;
  blockContent(findBlock(readDoc(session), "p3-0000-model")!).node.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === "italic")) italic += node.text;
    if (node.type.name === "inlineMath") atoms++;
  });
  expect(italic).toBe("c");
  expect(atoms).toBe(1);
});

test("each refusal is reported with its reason, and the rest still applies", async () => {
  const { session, docKey } = await setup({ observe: ["p4-0000-result"] });
  const result = await edit(docKey, [
    { paragraph: "p20000ci", old: "similar effects [@smith2020] in small samples", new: "similar effects in small samples" },
    { paragraph: "p30000mo", old: "coefficient c for", new: "slope for" },
    { paragraph: "p30000mo", old: "the indirect association", new: "the *indirect* association" },
    { paragraph: "p40000re", old: "We recieve", new: "We received" },
    { paragraph: "p10000cl", old: "These results show", new: "These data show" },
    { paragraph: "p10000cl", old: "the drug causes recovery", new: "the drug may aid recovery" },
  ]);
  expect(result.status).toBe("applied");
  expect(result.outcomes.map(({ applied, reason, detail }) => ({ applied, reason, detail }))).toEqual([
    { applied: false, reason: "atom", detail: "[@smith2020]" },
    { applied: false, reason: "format", detail: undefined },
    { applied: false, reason: "markup", detail: "*indirect*" },
    { applied: false, reason: "observe", detail: undefined },
    { applied: false, reason: "not-found", detail: undefined },
    { applied: true, reason: undefined, detail: undefined },
  ]);
  expect(acceptedText(session, "p1-0000-claim")).toBe("These results prove that the drug may aid recovery in all patients.");
  expect(liveText(session, "p4-0000-result")).toBe("We recieve the data from three sites. The data from three sites were pooled.");
});

test("paragraphs with pending suggestions and edits beyond the edit level are refused", async () => {
  const { session, docKey } = await setup();
  await edit(docKey, [{ paragraph: "p10000cl", old: "prove", new: "suggest" }]);
  session.ydoc.transact(() => setEditLevel(session.ydoc.getMap(WRITING_MAP), "proofread"), "editor");
  const result = await edit(docKey, [
    { paragraph: "p10000cl", old: "in all patients", new: "in most patients" },
    { paragraph: "p40000re", old: "We recieve the data from three sites. The data from three sites were pooled.", new: "Three sites contributed pooled records." },
  ]);
  expect(result.status).toBe("refused");
  expect(result.outcomes[0]).toMatchObject({ applied: false, reason: "pending" });
  expect(result.outcomes[1]).toMatchObject({ applied: false, reason: "level" });
  expect(result.outcomes[1].detail).toContain("(Proofread)");
  expect(result.changeSetId).toBeUndefined();
  expect(readRevisions(session.ydoc.getMap(REVISIONS_MAP))).toHaveLength(1);
});

test("new citations must be in references.bib; the Proofread level adds none", async () => {
  const { session, docKey } = await setup();
  const result = await edit(docKey, [{ paragraph: "p40000re", old: "were pooled.", new: "were pooled [@lee2019; @ghost2000]." }]);
  expect(result.status).toBe("applied");
  expect(result.removedCitations).toEqual([{ key: "ghost2000", why: "not-in-library" }]);
  expect(acceptedText(session, "p4-0000-result")).toBe("We recieve the data from three sites. The data from three sites were pooled [@lee2019].");

  session.ydoc.transact(() => setEditLevel(session.ydoc.getMap(WRITING_MAP), "proofread"), "editor");
  const proofread = await edit(docKey, [{ paragraph: "p20000ci", old: "in small samples.", new: "in small samples [@lee2019]." }]);
  expect(proofread.outcomes[0]).toMatchObject({ applied: false, reason: "unchanged" });
  expect(proofread.removedCitations).toEqual([{ key: "lee2019", why: "proofread" }]);
});

test("a wrong paragraph id still finds a quote that is unique in the document; a repeated quote is refused", async () => {
  const { session, docKey } = await setup();
  const result = await edit(docKey, [
    { paragraph: "p10000cl", old: "We recieve", new: "We receive" },
    { paragraph: "p40000re", old: "data from three sites", new: "records from three sites" },
  ]);
  expect(result.outcomes[0]).toMatchObject({ applied: true, blockId: "p4-0000-result" });
  expect(result.outcomes[1]).toMatchObject({ applied: false, reason: "ambiguous" });
  expect(acceptedText(session, "p4-0000-result")).toBe("We receive the data from three sites. The data from three sites were pooled.");
});

test("a paused agent and response letters are refused before any job", async () => {
  const { docKey } = await setup();
  agent!.setPaused(true);
  expect(await edit(docKey, [{ paragraph: "", old: "prove", new: "suggest" }])).toMatchObject({ status: "refused", reason: "paused" });
  agent!.setPaused(false);
  expect(await edit("/p::other.scholarpen.json", [{ paragraph: "", old: "prove", new: "suggest" }])).toMatchObject({ status: "refused", reason: "not-open" });
  expect(agent!.jobs(docKey)).toHaveLength(0);

  agent!.dispose();
  await registry.dispose();
  const letter = await setup({ filename: "response-letters/response-2026-11-01-abcd1234.scholarpen.json" });
  expect(await edit(letter.docKey, [{ paragraph: "", old: "prove", new: "suggest" }])).toMatchObject({ status: "refused", reason: "letter" });
});

test("the Assistant's prompt gets the document's edit level and Observe sections", async () => {
  const { session } = await setup();
  session.ydoc.transact(() => {
    setEditLevel(session.ydoc.getMap(WRITING_MAP), "proofread");
    session.ydoc.getMap(ZONES_MAP).set("h2-0000-results", { trust: "observe" });
  }, "editor");
  const rules = assistantEditRules(session, null);
  expect(rules).toContain("Edit level of the active document: Proofread (one edit may change at most 25% of a paragraph).");
  expect(rules).toContain("EDIT LEVEL: PROOFREAD.");
  expect(rules).toContain("Sections set to Observe, where every edit is refused: Results.");
});

test("a quote is found despite different spacing, quote marks or a copied heading marker", () => {
  expect(locateChange("He said “stop”  now.", { old: "said \"stop\" now", new: "said “wait” now" })).toEqual({ from: 3, to: 19, replacement: "said “wait” now" });
  expect(locateChange("Methods", { old: "[¶ab12cd34] ## Methods", new: "## Materials and methods" })).toEqual({ from: 0, to: 7, replacement: "Materials and methods" });
  expect(locateChange("First. Second. Third.", { old: "Second.", new: "" })).toEqual({ from: 7, to: 15, replacement: "" });
  expect(locateChange("First. Second.", { old: "Second.", new: "" })).toEqual({ from: 6, to: 14, replacement: "" });
  expect(locateChange("a b a", { old: "a", new: "c" })).toBe("ambiguous");
});
