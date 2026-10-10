import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";

const dom = new Window({ url: "http://localhost" });
const keys = ["window", "document", "navigator", "Node", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Event", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const { rpc } = await import("../../rpc");
const { DecisionQueue } = await import("./DecisionQueue");
const { RevisionHistory } = await import("./RevisionHistory");
const { EditLevelControl } = await import("./EditLevelControl");
const { ProjectPanel } = await import("./ProjectPanel");
const { COLLAB_THREADS_MAP } = await import("../../../shared/collab/protocol");
const { createThread, readThreads, AI_USER_ID } = await import("../../../shared/collab/threads");
const { recordRevision, REVISIONS_MAP } = await import("../../../shared/collab/revision-log");
const { editLevelOf, WRITING_MAP } = await import("../../../shared/collab/writing");

const exportFile = spyOn(rpc, "exportFile");
const getGlossary = spyOn(rpc, "getGlossary"), saveGlossary = spyOn(rpc, "saveGlossary");
const getMap = spyOn(rpc, "getManuscriptMap"), getReport = spyOn(rpc, "getConsistencyReport"), runCheck = spyOn(rpc, "runConsistencyCheck");
let root: Root | undefined;
let container: HTMLDivElement;
async function render(node: React.ReactNode) {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(node));
}
const button = (label: string) => Array.from(container.querySelectorAll("button")).find(item => item.textContent?.includes(label))!;
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
  await act(async () => {
    element.focus();
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    // React may fall back to its keyup-based change detection under happy-dom.
    element.dispatchEvent(new dom.KeyboardEvent("keyup", { key: "a", bubbles: true }) as unknown as Event);
  });
}
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; container?.remove();
  [exportFile, getGlossary, saveGlossary, getMap, getReport, runCheck].forEach(spy => spy.mockReset());
});
afterAll(() => {
  [exportFile, getGlossary, saveGlossary, getMap, getReport, runCheck].forEach(spy => spy.mockRestore());
  for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  void dom.happyDOM.abort();
});

test("an answered decision goes back to the AI on its thread", async () => {
  const ydoc = new Y.Doc();
  const map = ydoc.getMap(COLLAB_THREADS_MAP);
  const id = createThread(map, AI_USER_ID, "Qualify this.", { assignee: "me", manual: true, decision: { question: "Which endpoint is primary?", askedAt: 1 } });
  const threads = () => readThreads(map);
  await render(<DecisionQueue ydoc={ydoc} threads={threads()} level="sentence" reference={() => "the quoted passage"} onSelect={() => {}} />);
  expect(container.textContent).toContain("Decisions for you · 1");
  expect(container.textContent).toContain("Which endpoint is primary?");
  await type(container.querySelector("textarea")!, "Mortality at 30 days.");
  await act(async () => button("Answer · AI continues").click());
  const thread = threads().find(item => item.id === id)!;
  expect(thread.comments.at(-1)?.text).toBe("Mortality at 30 days.");
  expect(thread.meta).toMatchObject({ assignee: "ai" });
});

test("the edit level control writes the document's level", async () => {
  const ydoc = new Y.Doc();
  await render(<EditLevelControl ydoc={ydoc} />);
  await act(async () => button("Proofread").click());
  expect(editLevelOf(ydoc.getMap(WRITING_MAP))).toBe("proofread");
  expect(container.querySelector('[aria-checked="true"]')?.textContent).toBe("Proofread");
});

test("revision history lists AI revisions and exports the response letter", async () => {
  const ydoc = new Y.Doc();
  recordRevision(ydoc.getMap(REVISIONS_MAP), { createdAt: 1, kind: "comment", label: "Soften the claim", status: "accepted", summary: "Softened.",
    items: [{ threadId: "t", comment: "Too strong.", commentBy: "ai", response: "Softened.", outcome: "addressed", blockIds: ["p1"] }],
    paragraphs: [{ blockId: "p1", before: "prove", after: "suggest" }] });
  exportFile.mockResolvedValue("/project/exports/paper-response-to-reviewers.md");
  await render(<RevisionHistory ydoc={ydoc} documentName="paper.scholarpen.json" projectPath="/project" />);
  await act(async () => button("Revision history").click());
  expect(container.textContent).toContain("Soften the claim");
  expect(container.textContent).toContain("Accepted");
  await act(async () => button("Export response to reviewers").click());
  expect(exportFile).toHaveBeenCalledWith("/project", "paper-response-to-reviewers.md", expect.stringContaining("> Too strong."));
  expect(container.textContent).toContain("1 responses saved");
});

test("the Project tab edits the glossary and shows the consistency report", async () => {
  getGlossary.mockResolvedValue({ entries: [{ term: "randomized controlled trial", abbreviation: "RCT" }] });
  saveGlossary.mockImplementation(async (_path, glossary) => ({ ...glossary, updatedAt: 2 }));
  getMap.mockResolvedValue({ documents: [{ filename: "ch1.scholarpen.json", stale: false, entry: { filename: "ch1.scholarpen.json", hash: "h", title: "Chapter 1",
    summary: "Opens the book.", claims: [], numbers: [], updatedAt: 1, terms: [{ term: "burnout", definition: "chronic exhaustion", quote: "q" }] } }], job: { state: "idle" } });
  getReport.mockResolvedValue({ job: { state: "idle" }, report: { createdAt: 1, documents: 2, posted: 1, skipped: [], issues: [
    { id: "i", kind: "contradiction", filename: "ch2.scholarpen.json", quote: "150 patients", comment: "Sample sizes differ.", related: { filename: "ch1.scholarpen.json", quote: "120 patients" } }] } });
  runCheck.mockResolvedValue({ job: { state: "running", detail: "Reading" }, report: null });
  const opened: string[] = [];
  await render(<ProjectPanel projectPath="/project" onOpenDocument={filename => opened.push(filename)} />);
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Abbreviation"]')?.value).toBe("RCT");
  await act(async () => button("burnout").click()); // A term the manuscript map found.
  await act(async () => button("Save glossary").click());
  expect(saveGlossary).toHaveBeenCalledWith("/project", { entries: [{ term: "randomized controlled trial", abbreviation: "RCT" }, { term: "burnout", definition: "chronic exhaustion" }] });
  await act(async () => button("Consistency across documents").click());
  expect(container.textContent).toContain("Sample sizes differ.");
  expect(container.textContent).toContain("ch1: “120 patients”");
  await act(async () => button("ch2").click());
  expect(opened).toEqual(["ch2.scholarpen.json"]);
  await act(async () => button("Check the whole project").click());
  expect(runCheck).toHaveBeenCalledWith("/project");
  expect(container.textContent).toContain("Reading");
});
