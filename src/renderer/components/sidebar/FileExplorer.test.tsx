import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FileNode } from "@shared/rpc-types";
const dom = new Window();
const keys = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "MutationObserver", "ResizeObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "DocumentFragment", "NodeFilter", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const { FileExplorer } = await import("./FileExplorer");
let root: Root | undefined;
let container: HTMLDivElement;
const native: FileNode = { name: "native.scholarpen.json", path: "/project/documents/native.scholarpen.json", kind: "document", isDirectory: false, lastModified: 0 };
const md: FileNode = { ...native, name: "chapter.md", path: "/project/exports/chapter.md", kind: "note" };
const qmd: FileNode = { ...md, name: "chapter.qmd", path: "/project/exports/chapter.qmd" };
const imported = mock(async (_path: string, _open?: boolean) => {});
const deleted = mock(async (_path: string) => {});
const refresh = mock(async () => {});
const exported = mock((_files: FileNode[]) => {});
async function mount() {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<FileExplorer projects={[]} activeProject={{ name: "project", path: "/project", files: [], lastModified: 0 }}
    onProjectChange={() => {}} onCreateProject={async () => {}} fileTree={[native, md, qmd]} activeFile={md}
    onFileSelect={() => {}} onOpenSettings={() => {}} onRefreshTree={refresh} onExportDocuments={exported}
    onFindReplaceDocuments={() => {}} onImportFile={imported} onFileRenamed={() => {}} onDeleteFile={deleted} />));
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === label || button.textContent?.trim() === label);
  expect(Boolean(button)).toBe(true);
  await act(async () => button!.click());
}
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; container?.remove();
  imported.mockClear(); deleted.mockReset(); refresh.mockClear(); exported.mockClear();
});
afterAll(() => {
  for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  dom.happyDOM.abort();
});
test("mixed selection imports only MD/QMD and leaves the native document selected for export", async () => {
  await mount();
  await click("Select documents or Markdown files");
  await click("Select all");
  await click("Import 2 MD/QMD");
  expect(imported.mock.calls).toEqual([[md.path, false], [qmd.path, false]]);
  expect(refresh).toHaveBeenCalledTimes(1);
  await click("Export 1 section");
  expect(exported).toHaveBeenCalledWith([native]);
});
test("delete confirmation can be cancelled and partial failures remain selected", async () => {
  await mount();
  await click("Select documents or Markdown files");
  await click("Select all");
  await click("Delete 3 files");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("exports/chapter.qmd");
  await click("Cancel");
  expect(deleted).not.toHaveBeenCalled();
  deleted.mockImplementation(async path => { if (path === md.path) throw new Error("Permission denied"); });
  await click("Delete 3 files");
  await click("Delete");
  expect(deleted.mock.calls.map(call => call[0])).toEqual([native.path, md.path, qmd.path]);
  expect(container.textContent).toContain("Deleted 2 file(s).");
  expect(container.textContent).toContain("Permission denied");
  expect(container.querySelector('[aria-label="Clear chapter.md"]')?.getAttribute("aria-checked")).toBe("true");
});
