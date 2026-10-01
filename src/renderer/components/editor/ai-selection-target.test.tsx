import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextSelection } from "prosemirror-state";
import type { ScholarEditor } from "../../blocks/schema";
import type { SelectionSnapshot } from "./AIInlineEditPanel";

const dom = new Window();
Object.defineProperty(dom.document, "compatMode", { value: "CSS1Compat" });
const globals = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "DocumentFragment", "DOMParser", "Text", "NodeFilter", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true,
  value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const { BlockNoteEditor } = await import("@blocknote/core");
const { BlockNoteViewRaw } = await import("@blocknote/react");
const { scholarSchema } = await import("../../blocks/schema");
const { AIInlineEditPanel } = await import("./AIInlineEditPanel");
const { AISelectionTargetExtension, applyAISelection, trackAISelection, releaseAISelection } = await import("./ai-selection-target");
const { protectSelectionSlice, buildInlineEditDocumentContext, isSameProtectedSlice } = await import("./ai-inline-edit-protection");
const { createDeepenAnalysisRequest } = await import("../../ai/deepen-analysis");
const { applySelectionReviewResult } = await import("../../ai/selection-review-result");
let editor: ScholarEditor;
let root: Root | undefined;
let container: HTMLDivElement;
let snapshot: SelectionSnapshot;
let complete: () => void;
let notice: ReturnType<typeof applySelectionReviewResult> | undefined;
let changeCount = 0;

async function mount() {
  editor = BlockNoteEditor.create({ schema: scholarSchema, extensions: [AISelectionTargetExtension()], initialContent: [
    { id: "before", type: "paragraph", content: "Before the selection." },
    { id: "selected", type: "paragraph", content: [
      { type: "text", text: "The claim proves causation.", styles: { bold: true } },
      { type: "citation", props: { citekey: "smith2026", locator: "p. 4" } },
    ] },
    { id: "selected2", type: "paragraph", content: "There is a typo here." },
    { id: "after", type: "paragraph", content: "After the selection." },
  ] });
  editor.onChange(() => { changeCount++; });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await render(false);
  let from = 0, to = 0;
  editor.prosemirrorView.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === "The claim proves causation.") from = pos;
    if (node.isText && node.text === "There is a typo here.") to = pos + node.nodeSize;
  });
  const view = editor.prosemirrorView;
  await act(async () => { view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to))); });
  const selectedText = editor.getSelectedText();
  const protection = protectSelectionSlice(view.state.doc.slice(from, to), selectedText);
  snapshot = { from, to, selectedText, protection,
    documentContext: buildInlineEditDocumentContext(view.state.doc, from, to), top: 0, bottom: 20, left: 0 };
  await act(async () => { trackAISelection(view, from, to, protection); });
  await render(true);
}

async function render(panel: boolean) {
  await act(async () => { root!.render(<>
    <BlockNoteViewRaw editor={editor} formattingToolbar={false} linkToolbar={false} slashMenu={false}
      emojiPicker={false} sideMenu={false} filePanel={false} tableHandles={false} comments={false} />
    {panel && <AIInlineEditPanel snapshot={snapshot} model="fixture" onAccept={() => null} onDeepen={() => {}}
      onFindCitation={() => {}} onClose={() => {}} onValidate={saved => {
        const request = createDeepenAnalysisRequest(saved.selectedText, saved.documentContext, saved.protection, "validate");
        const revised = saved.protection.protectedText.replace("proves causation", "reports an association").replace("typo", "correction");
        complete = () => {
          notice = applySelectionReviewResult(request, `Evidence [W1]\n## Validation verdict\nCORRECTED\n## 통합 개선문\n${revised}`, "complete", (_id, revision) => {
            const error = revision === null ? null : applyAISelection(editor.prosemirrorView, saved.protection, revision);
            releaseAISelection(editor.prosemirrorView, saved.protection);
            return error;
          });
        };
      }} />}
  </>); });
}

async function clickValidate() {
  const button = Array.from(document.querySelectorAll("button")).find(el => el.textContent === "Validate");
  expect(button).toBeDefined();
  await act(async () => { button!.click(); });
  await render(false);
}

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined; container?.remove(); notice = undefined; changeCount = 0;
});
afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.happyDOM.abort();
});

test("popup Validate automatically replaces multiple real BlockNote blocks, preserves citations/bold, fires change, and selects the revision", async () => {
  await mount(); await clickValidate();
  const beforeCount = changeCount;
  await act(async () => { complete(); });
  expect(notice?.kind).toBe("success");
  expect(editor.getSelectedText()).toContain("reports an association");
  expect(editor.getSelectedText()).toContain("correction");
  expect(JSON.parse(JSON.stringify(editor.document[1].content))).toEqual([
    { type: "text", text: "The claim reports an association.", styles: { bold: true } },
    { type: "citation", props: { citekey: "smith2026", locator: "p. 4" } },
  ]);
  expect(editor.document[0].content).toEqual([{ type: "text", text: "Before the selection.", styles: {} }]);
  expect(editor.document[3].content).toEqual([{ type: "text", text: "After the selection.", styles: {} }]);
  expect(changeCount).toBeGreaterThan(beforeCount);
});

test("an edit before the selection reproduces the old false stale failure, while the tracked selection still applies", async () => {
  await mount(); await clickValidate();
  await act(async () => { editor.updateBlock("before", { content: "A much longer paragraph inserted before the unchanged selection." }); });
  expect(isSameProtectedSlice(editor.prosemirrorView.state.doc.slice(snapshot.from, snapshot.to), snapshot.protection)).toBe(false);
  await act(async () => { complete(); });
  expect(notice?.kind).toBe("success");
  expect(editor.getSelectedText()).toContain("reports an association");
  expect(editor.prosemirrorView.state.doc.textContent).toContain("A much longer paragraph");
});

test("moving the cursor or editing after the selection does not redirect the replacement", async () => {
  await mount(); await clickValidate();
  await act(async () => {
    editor.updateBlock("after", { content: "A user edit after the selection." });
    editor.setTextCursorPosition("after", "end");
    complete();
  });
  expect(notice?.kind).toBe("success");
  expect(editor.getSelectedText()).toContain("reports an association");
  expect(editor.prosemirrorView.state.doc.textContent).toContain("A user edit after the selection.");
});

test("text inserted exactly at either boundary stays outside the replacement", async () => {
  await mount(); await clickValidate();
  await act(async () => {
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.insertText(" suffix", snapshot.to).insertText("prefix ", snapshot.from));
    complete();
  });
  expect(notice?.kind).toBe("success");
  expect(editor.getSelectedText()).not.toContain("prefix");
  expect(editor.getSelectedText()).not.toContain("suffix");
  expect(editor.prosemirrorView.state.doc.textContent).toContain("prefix The claim reports an association.");
  expect(editor.prosemirrorView.state.doc.textContent).toContain("There is a correction here. suffix");
});

test("a filtered editor transaction cannot be reported as successfully applied", async () => {
  await mount(); await clickValidate();
  const before = JSON.stringify(editor.document);
  const unsubscribe = editor.onBeforeChange(() => false);
  try {
    await act(async () => { complete(); });
    expect(notice?.kind).toBe("error");
    expect(JSON.stringify(editor.document)).toBe(before);
  } finally { unsubscribe(); }
});

for (const change of ["edit", "delete"] as const) {
  test(`a ${change} inside the selection prevents overwriting user work`, async () => {
    await mount(); await clickValidate();
    await act(async () => {
      if (change === "edit") editor.updateBlock("selected2", { content: "New wording by the user." });
      else editor.removeBlocks(["selected"]);
    });
    const before = JSON.stringify(editor.document);
    await act(async () => { complete(); });
    expect(notice?.kind).toBe("error");
    expect(notice?.message).toContain("선택 영역의 내용이나 서식이 변경");
    expect(JSON.stringify(editor.document)).toBe(before);
  });
}
