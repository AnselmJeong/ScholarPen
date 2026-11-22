import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
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
const { Transform } = await import("prosemirror-transform");
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
const { listHunks } = await import("../../../renderer/collab/suggestion-hunks");
const { resolveSuggestions } = await import("../../../shared/collab/resolve-suggestions");

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
  { id: "p5-0000-prior", type: "paragraph", content: [
    { type: "text", text: "Two cohorts were enrolled. Prior work reported a protective effect ", styles: {} },
    { type: "citation", props: { citekey: "kim2020", locator: "" } },
    { type: "text", text: ". The cohorts were pooled.", styles: {} },
  ] },
  // Typed backticks are protected literal markup; the "\n" is a line break node.
  { id: "p6-0000-code", type: "paragraph", content: "Estimates are in `results.csv`. Each row is one site.\nSites are listed below." },
  { id: "p7-0000-two", type: "paragraph", content: [
    { type: "text", text: "Effects were large ", styles: {} },
    { type: "citation", props: { citekey: "smith2020", locator: "" } },
    { type: "text", text: " and lasting ", styles: {} },
    { type: "citation", props: { citekey: "kim2020", locator: "" } },
    { type: "text", text: ".", styles: {} },
  ] },
  { id: "p8-0000-xref", type: "paragraph", content: [
    { type: "text", text: "As shown in ", styles: {} },
    { type: "crossReference", props: { label: "fig-a", locator: "", bracketed: false } },
    { type: "text", text: " and ", styles: {} },
    { type: "crossReference", props: { label: "fig-b", locator: "", bracketed: false } },
    { type: "text", text: ", effects grew.", styles: {} },
  ] },
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
  const tr = new Transform(readDoc(session));
  resolveSuggestions(tr, true);
  const doc = tr.doc;
  const content = blockContent(findBlock(doc, blockId)!);
  return doc.textBetween(content.from, content.to, "", (node) => node.type.name === "citation" ? `[@${node.attrs.citekey}]` : node.type.name === "inlineMath" ? `$${node.attrs.formula}$` : "");
}

function liveText(session: any, blockId: string) {
  return blockContent(findBlock(readDoc(session), blockId)!).node.textContent;
}

/** A block's inline content, with each formatting run and inline node spelled out: `⟨italic c⟩`, `⟨citation kim2020⟩`. */
function inlineView(content: any) {
  let out = "";
  content.forEach((node: any) => {
    if (node.isText) {
      // Suggestion and AI-authorship marks are not formatting.
      const styles = node.marks.map((mark: any) => mark.type.name).filter((name: string) => !["deletion", "insertion", "aiAuthored"].includes(name));
      out += styles.length ? `⟨${styles.join("+")} ${node.text}⟩` : node.text;
    } else if (node.type.name === "citation") out += `⟨citation ${node.attrs.citekey}⟩`;
    else if (node.type.name === "inlineMath") out += `⟨math ${node.attrs.formula}⟩`;
    else if (node.type.name === "crossReference") out += `⟨ref ${node.attrs.label}⟩`;
    else out += `⟨${node.type.name}⟩`;
  });
  return out;
}

/** The block after the author keeps (or reverts) one change set, as Keep and Revert do it in the editor. */
function decided(session: any, id: number, keep: boolean, blockId: string) {
  const tr = new Transform(readDoc(session));
  expect(resolveSuggestions(tr, keep, id)).toBe(true);
  expect(hasSuggestionMarks(tr.doc)).toBe(false);
  return inlineView(blockContent(findBlock(tr.doc, blockId)!).node);
}

/** The pieces of a block a suggestion strikes, with their change-set ids. */
function struck(session: any, blockId: string) {
  const pieces: Array<{ piece: string; id: unknown }> = [];
  blockContent(findBlock(readDoc(session), blockId)!).node.forEach((node: any) => {
    const mark = node.marks.find((item: any) => item.type.name === "deletion");
    if (mark) pieces.push({ piece: inlineView({ forEach: (visit: any) => visit(node) }), id: mark.attrs.id });
  });
  return pieces;
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
    // The quote cuts through the citation, so it may not remove it.
    { paragraph: "p20000ci", old: "smith2020] in small samples", new: "in small cohorts" },
    { paragraph: "p60000co", old: "`results.csv`", new: "`estimates.csv`" },
    { paragraph: "p30000mo", old: "the indirect association", new: "the *indirect* association" },
    { paragraph: "p40000re", old: "We recieve", new: "We received" },
    { paragraph: "p10000cl", old: "These results show", new: "These data show" },
    { paragraph: "p10000cl", old: "the drug causes recovery", new: "the drug may aid recovery" },
    { paragraph: "p60000co", old: "one site. Sites are listed", new: "one site, and sites are listed" },
    // A cross-reference written back altered would land as plain text.
    { paragraph: "p80000xr", old: "@fig-a and @fig-b", new: "@fig-c and @fig-b" },
  ]);
  expect(result.status).toBe("applied");
  expect(result.outcomes.map(({ applied, reason, detail }) => ({ applied, reason, detail }))).toEqual([
    { applied: false, reason: "atom", detail: "[@smith2020]" },
    { applied: false, reason: "format", detail: "markup" },
    { applied: false, reason: "markup", detail: "*indirect*" },
    { applied: false, reason: "observe", detail: undefined },
    { applied: false, reason: "not-found", detail: undefined },
    { applied: true, reason: undefined, detail: undefined },
    // A reworded passage keeps its line breaks; only a passage deleted outright takes one along.
    { applied: false, reason: "atom", detail: "\n" },
    { applied: false, reason: "atom", detail: "@fig-a" },
  ]);
  expect(acceptedText(session, "p1-0000-claim")).toBe("These results prove that the drug may aid recovery in all patients.");
  expect(liveText(session, "p4-0000-result")).toBe("We recieve the data from three sites. The data from three sites were pooled.");
  expect(hasSuggestionMarks(blockContent(findBlock(readDoc(session), "p2-0000-cited")!).node)).toBe(false);
  expect(hasSuggestionMarks(blockContent(findBlock(readDoc(session), "p6-0000-code")!).node)).toBe(false);
});

test("deleting a sentence takes its italic variable and equation along: one tracked deletion, removed by Keep, restored by Revert", async () => {
  const { session, docKey } = await setup();
  // The sentence is 74% of its paragraph: more than the Sentence level lets one edit change.
  session.ydoc.transact(() => setEditLevel(session.ydoc.getMap(WRITING_MAP), "structural"), "editor");
  const sentence = "We fitted a model yielding the coefficient c for each predictor and defined $a \\times b$ as the indirect association.";
  const result = await edit(docKey, [{ paragraph: "p30000mo", old: sentence, new: "" }], "Delete the first sentence of the model paragraph.");
  expect(result).toMatchObject({ status: "applied", outcomes: [{ index: 0, applied: true, blockId: "p3-0000-model" }] });

  // The italic run and the equation are struck with the rest, all in the request's change set.
  const id = result.changeSetId!;
  expect(struck(session, "p3-0000-model")).toEqual([
    { piece: "We fitted a model yielding the coefficient ", id },
    { piece: "⟨italic c⟩", id },
    { piece: " for each predictor and defined ", id },
    // The Y.Doc keeps no marks on inline nodes: a struck equation is text standing in for it until Keep or Revert.
    { piece: "⟨pendingNode $a \\times b$⟩", id },
    { piece: " as the indirect association. ", id },
  ]);
  // One review card: the sentence struck whole, nothing written in its place.
  const doc = readDoc(session);
  const [set] = listChangeSets(doc, session.ydoc.getMap(CHANGE_SETS_MAP));
  expect(set).toMatchObject({ id, info: { label: "Assistant: Delete the first sentence of the model paragraph." } });
  const hunks = listHunks(doc).filter((hunk) => hunk.blockId === "p3-0000-model");
  expect(hunks).toHaveLength(1);
  expect(hunks[0]).toMatchObject({ id, before: sentence, after: "" });
  const [revision] = readRevisions(session.ydoc.getMap(REVISIONS_MAP));
  expect(revision.paragraphs).toMatchObject([{ blockId: "p3-0000-model", after: "The fit was adequate." }]);

  expect(decided(session, id, true, "p3-0000-model")).toBe("The fit was adequate.");
  expect(decided(session, id, false, "p3-0000-model"))
    .toBe("We fitted a model yielding the coefficient ⟨italic c⟩ for each predictor and defined ⟨math a \\times b⟩ as the indirect association. The fit was adequate.");
});

test("deleting a sentence that ends in a citation strikes the citation in the same change set; Revert brings the node back", async () => {
  const { session, docKey } = await setup();
  const result = await edit(docKey, [
    // kim2020 is not in references.bib: removing a citation needs no library.
    { paragraph: "p50000pr", old: "Prior work reported a protective effect [@kim2020].", new: "" },
    // Typed markup goes whole with its sentence.
    { paragraph: "p60000co", old: "Estimates are in `results.csv`.", new: "" },
    // A cross-reference goes with its phrase.
    { paragraph: "p80000xr", old: "@fig-a and", new: "" },
  ], "Delete the unsupported sentences.");
  expect(result.status).toBe("applied");
  expect(result.outcomes.every((outcome) => outcome.applied)).toBe(true);
  expect(result.removedCitations).toEqual([]);
  const id = result.changeSetId!;
  expect(struck(session, "p5-0000-prior")).toEqual([
    { piece: "Prior work reported a protective effect ", id },
    { piece: "⟨pendingNode [@kim2020]⟩", id },
    { piece: ". ", id },
  ]);
  const sets = listChangeSets(readDoc(session), session.ydoc.getMap(CHANGE_SETS_MAP));
  expect(sets).toHaveLength(1);
  expect(sets[0].paragraphs.map((paragraph) => paragraph.blockId)).toEqual(["p5-0000-prior", "p6-0000-code", "p8-0000-xref"]);
  expect(listHunks(readDoc(session)).filter((hunk) => hunk.blockId === "p5-0000-prior"))
    .toMatchObject([{ id, before: "Prior work reported a protective effect [@kim2020].", after: "" }]);

  expect(decided(session, id, true, "p5-0000-prior")).toBe("Two cohorts were enrolled. The cohorts were pooled.");
  expect(decided(session, id, true, "p6-0000-code")).toBe("Each row is one site.⟨hardBreak⟩Sites are listed below.");
  expect(decided(session, id, true, "p8-0000-xref")).toBe("As shown in ⟨ref fig-b⟩, effects grew.");
  expect(decided(session, id, false, "p8-0000-xref")).toBe("As shown in ⟨ref fig-a⟩ and ⟨ref fig-b⟩, effects grew.");
  expect(decided(session, id, false, "p5-0000-prior")).toBe("Two cohorts were enrolled. Prior work reported a protective effect ⟨citation kim2020⟩. The cohorts were pooled.");
  expect(decided(session, id, false, "p6-0000-code")).toBe("Estimates are in `results.csv`. Each row is one site.⟨hardBreak⟩Sites are listed below.");
});

test("citations swapped within a change stay citation nodes, even one references.bib lacks", async () => {
  const { session, docKey } = await setup();
  const result = await edit(docKey, [{ paragraph: "p70000tw", old: "large [@smith2020] and lasting [@kim2020]", new: "lasting [@kim2020] and large [@smith2020]" }]);
  expect(result).toMatchObject({ status: "applied", removedCitations: [] });
  expect(decided(session, result.changeSetId!, true, "p7-0000-two"))
    .toBe("Effects were lasting ⟨citation kim2020⟩ and large ⟨citation smith2020⟩.");
  expect(decided(session, result.changeSetId!, false, "p7-0000-two"))
    .toBe("Effects were large ⟨citation smith2020⟩ and lasting ⟨citation kim2020⟩.");
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
