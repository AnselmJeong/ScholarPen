import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
const dom = new Window();
Object.defineProperty(dom.document, "compatMode", { value: "CSS1Compat" });
const keys = ["window", "document", "navigator", "localStorage", "Node", "NodeFilter", "HTMLElement", "HTMLInputElement", "MutationObserver", "Event", "KeyboardEvent", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const { rpc } = await import("../../rpc");
const { FileViewer } = await import("./FileViewer");
const read = spyOn(rpc, "readTextFile");
let root: Root | undefined;
let container: HTMLDivElement;
async function render(extension: string, reload = 0) {
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  const file = { name: `chapter.${extension}`, path: `/project/chapter.${extension}`, kind: "note" as const, isDirectory: false, lastModified: 0 };
  await act(async () => root!.render(<><FileViewer file={file} projectPath="/project" reloadTrigger={reload} /><FileViewer file={{ ...file, path: "/project/hidden.md" }} projectPath="/project" isActive={false} /></>));
}
async function shortcut(key: string) { await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true }))); }
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container?.remove(); read.mockReset(); });
afterAll(() => {
  read.mockRestore();
  for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  dom.happyDOM.abort();
});
for (const ext of ["md", "qmd"]) test(`${ext} preview search/replace shortcuts target only the active tab and survive zoom and reload`, async () => {
  read.mockResolvedValue("# Heading\n\nalpha **alpha** and alpha\n\n- item\n\n![plot](https://example.invalid/plot.png)");
  await render(ext);
  const image = container.querySelector("img");
  await shortcut("f");
  expect(container.querySelectorAll('input[placeholder="Find…"]').length).toBe(1);
  const input = container.querySelector('input[placeholder="Find…"]') as HTMLInputElement;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "alpha");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
  });
  expect(container.textContent).toContain("1/3");
  await act(async () => (container.querySelector('button[title="글자 크게"]') as HTMLButtonElement).click());
  expect(container.textContent).toContain("1/3");
  expect(container.querySelector("img") === image).toBe(true);
  await shortcut("h");
  expect(container.textContent).toContain("preview is read-only");
  read.mockResolvedValue("# Reloaded\n\nreplacement **text**");
  await render(ext, 1);
  expect(container.textContent).toContain("replacement text");
  expect(container.querySelector('input[placeholder="Find…"]')).toBeNull();
});
