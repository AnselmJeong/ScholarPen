import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { findEditorTextMatches } from "../../utils/editor-text-find";
import { findDocumentTextMatches } from "../../utils/document-text-replace";
import type { ScholarEditor } from "../../blocks/schema";

const dom = new Window();
Object.defineProperty(dom.document, "compatMode", { value: "CSS1Compat" });
const globals = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "MutationObserver", "CustomEvent", "Event", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "MouseEvent", "KeyboardEvent", "DocumentFragment", "DOMParser", "Text", "NodeFilter", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true,
  value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const { rpc } = await import("../../rpc");
const { BlockNoteEditor } = await import("@blocknote/core");
const { BlockNoteViewRaw } = await import("@blocknote/react");
const { scholarSchema } = await import("../../blocks/schema");
const { FindReplacePanel } = await import("./FindReplacePanel");
let root: Root | undefined;
let container: HTMLDivElement;
let editor: ScholarEditor;
const list = spyOn(rpc, "listProjectFiles");
const load = spyOn(rpc, "loadDocument");
const navigate = mock(() => {});

const fixture = [
  { id: "intro", type: "heading", props: { label: "sec-intro" }, content: "Introduction" },
  { id: "refs", type: "paragraph", content: [
    { type: "text", text: "See " },
    { type: "crossReference", props: { label: "fig-network" } },
    { type: "text", text: " and " },
    { type: "citation", props: { citekey: "Smith2024", locator: "p. 2" } },
    { type: "crossReference", props: { label: "eq-energy" } },
    { type: "text", text: " @fig-network" },
  ], children: [{ type: "paragraph", content: [{ type: "crossReference", props: { label: "sec-intro" } }] }] },
  { id: "figure", type: "figure", props: { label: "fig-network", caption: "Network", url: "data:image/png;base64,AA==" } },
  { id: "table", type: "table", props: { label: "tbl-results" }, content: { type: "tableContent", rows: [{ cells: [
    [{ type: "crossReference", props: { label: "fig-network" } }],
    { type: "tableCell", content: [{ type: "citation", props: { citekey: "Smith2024" } }] },
  ] }] } },
  { id: "equation", type: "math", props: { label: "eq-energy", formula: "E=mc^2" } },
];

async function mount(project = false) {
  editor = BlockNoteEditor.create({ schema: scholarSchema, initialContent: fixture as any });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(<>
    <BlockNoteViewRaw editor={editor} formattingToolbar={false} linkToolbar={false} slashMenu={false}
      emojiPicker={false} sideMenu={false} filePanel={false} tableHandles={false} comments={false} />
    <FindReplacePanel editor={editor} isOpen onClose={() => {}} showReplaceInitially
      initialScope={project ? "project" : "document"} projectPath="/project" documentFilename="a.scholarpen.json"
      documentReady onNavigateToDocument={navigate} />
  </>); });
}

async function input(placeholder: string, value: string) {
  const field = container.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement;
  await act(async () => {
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent("keyup", { key: value.at(-1), bubbles: true }));
  });
}

async function press(title: string) {
  const button = container.querySelector(`button[title="${title}"]`) as HTMLButtonElement;
  expect(button).not.toBeNull();
  await act(async () => { button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
}

function currentNodeAttribute(attribute: string) {
  const current = container.querySelector('[data-find-match="current"]');
  return current?.getAttribute(attribute) ?? current?.querySelector(`[${attribute}]`)?.getAttribute(attribute);
}

afterEach(async () => {
  await act(async () => { root?.unmount(); }); root = undefined; container?.remove();
  list.mockReset(); load.mockReset(); navigate.mockClear();
});
afterAll(() => {
  list.mockRestore(); load.mockRestore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.happyDOM.abort();
});

test("real BlockNote positions and saved JSON give identical ordered results for every reference type", async () => {
  await mount();
  const before = JSON.stringify(editor.document);
  for (const query of ["@", "@fig-network", "FIG-NET", "@tbl-results", "@sec-intro", "@eq-energy", "@Smith2024", "Smith", "p. 2"]) {
    const live = findEditorTextMatches(editor.prosemirrorView.state.doc, query);
    const saved = findDocumentTextMatches(editor.document, query);
    expect(live.length).toBeGreaterThan(0);
    expect(live.map(({ kind, snippet, snippetOffset }) => ({ kind, snippet, snippetOffset })))
      .toEqual(saved.map(({ kind, snippet, snippetOffset }) => ({ kind, snippet, snippetOffset })));
  }
  expect(JSON.stringify(editor.document)).toBe(before);
});

test("panel highlights badges and actual figure targets, navigates both directions, and preserves references on replace", async () => {
  await mount();
  const before = JSON.stringify(editor.document);
  await input("Find…", "@fig-network");
  expect(container.textContent).toContain("1 / 4");
  expect(currentNodeAttribute("data-inline-content-type")).toBe("crossReference");
  await press("Next (Enter)");
  expect(container.textContent).toContain("2 / 4");
  expect((container.querySelector('button[title="Replace this"]') as HTMLButtonElement).disabled).toBe(false);
  await press("Next (Enter)");
  expect(currentNodeAttribute("data-content-type")).toBe("figure");
  expect((container.querySelector('button[title="Replace this"]') as HTMLButtonElement).disabled).toBe(true);
  await press("Previous (Shift+Enter)");
  expect(container.textContent).toContain("2 / 4");
  expect(JSON.stringify(editor.document)).toBe(before);
  await input("Replace with…", "updated");
  await press("Replace all");
  expect(findEditorTextMatches(editor.prosemirrorView.state.doc, "@fig-network").map((m) => m.kind))
    .toEqual(["annotation", "annotation", "annotation"]);
  expect(container.textContent).toContain("1 / 3");
  expect((container.querySelector('button[title="Replace all"]') as HTMLButtonElement).disabled).toBe(true);
  expect(editor.getBlock("figure")?.props).toMatchObject({ label: "fig-network" });
});

test("citation, heading, table and equation searches decorate their nodes and clear when query is removed", async () => {
  await mount();
  for (const [query, attr, type] of [
    ["@Smith2024", "data-inline-content-type", "citation"],
    ["@sec-intro", "data-content-type", "heading"],
    ["@tbl-results", "data-content-type", "table"],
    ["@eq-energy", "data-inline-content-type", "crossReference"],
  ]) {
    await input("Find…", query);
    expect(currentNodeAttribute(attr)).toBe(type);
  }
  await press("Next (Enter)");
  expect(currentNodeAttribute("data-content-type")).toBe("math");
  await input("Find…", "");
  expect(container.querySelectorAll("[data-find-match]")).toHaveLength(0);
});

test("project results include unopened document targets and pass their exact mixed-result index for navigation", async () => {
  list.mockResolvedValue([{ name: "documents", path: "/project/documents", isDirectory: true, children: [
    { name: "b.scholarpen.json", path: "/project/documents/b.scholarpen.json", isDirectory: false, kind: "document" },
  ] }] as any);
  load.mockResolvedValue(fixture as any);
  await mount(true);
  await input("Find…", "@fig-network");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  expect(container.textContent).toContain("1 / 4");
  const results = [...container.querySelectorAll("button")].filter((button) => button.querySelector("mark"));
  expect(results).toHaveLength(4);
  await act(async () => { results[2].click(); });
  expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
    filename: "b.scholarpen.json", searchTerm: "@fig-network", matchIndex: 2, scope: "project",
  }));
  expect((container.querySelector('button[title="Replace selected occurrence"]') as HTMLButtonElement).disabled).toBe(true);
});

test("repeated occurrences inside the same key keep its current highlight when navigating", async () => {
  await mount();
  await act(async () => { editor.updateBlock("refs", { content: [
    { type: "citation", props: { citekey: "repeat-repeat", locator: "" } },
  ] }); });
  await input("Find…", "repeat");
  expect(container.textContent).toContain("1 / 2");
  expect(currentNodeAttribute("data-inline-content-type")).toBe("citation");
  await press("Next (Enter)");
  expect(container.textContent).toContain("2 / 2");
  expect(container.querySelectorAll('[data-find-match="current"]')).toHaveLength(1);
  expect(currentNodeAttribute("data-inline-content-type")).toBe("citation");
});
