import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const dom = new Window();
const globals = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "MutationObserver", "DocumentFragment", "DOMParser", "Text", "NodeFilter", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true,
  value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });
let sendUpdate: (payload: { projectPath: string; filePath: string }) => void = () => {};
mock.module("electrobun/view", () => ({ Electroview: class {
  static defineRPC(options: { handlers: { messages: { projectUpdated: typeof sendUpdate } } }) {
    return options;
  }
} }));
const rpcModule = await import("../rpc");
const { rpc } = rpcModule;
const projectListeners = new Set<(projectPath: string, filePath?: string) => void>();
const subscribe = spyOn(rpcModule, "onProjectUpdated").mockImplementation((handler) => {
  projectListeners.add(handler);
  return () => { projectListeners.delete(handler); };
});
sendUpdate = ({ projectPath, filePath }) => {
  projectListeners.forEach((handler) => handler(projectPath, filePath));
};
const { FigureDocumentContext, FigureImage } = await import("./figure-image");
let root: Root | undefined;
let container: HTMLDivElement;
const read = spyOn(rpc, "readFigure");
const select = spyOn(rpc, "selectFigure");
const first = "data:image/png;base64,Zmlyc3Q=";
const second = "data:image/png;base64,c2Vjb25k";
let updates: Array<{ sourcePath: string; url: string }> = [];
async function render(sourcePath = "figures/plot.png", documentPath = "/project/documents/a.scholarpen.json", url = "") {
  if (!root) {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  }
  await act(async () => { root!.render(<FigureDocumentContext.Provider value={{ projectPath: "/project", documentPath }}>
    <FigureImage sourcePath={sourcePath} url={url} alt="Caption" onSourceChange={(source) => { updates.push(source); }} />
  </FigureDocumentContext.Provider>); });
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((node) => node.textContent === text);
  expect(button).toBeDefined();
  await act(async () => { button!.click(); });
}
afterEach(async () => {
  await act(async () => { root?.unmount(); }); root = undefined; container?.remove();
  updates = []; read.mockReset(); select.mockReset();
});
afterAll(() => {
  read.mockRestore(); select.mockRestore(); subscribe.mockRestore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.happyDOM.abort();
});

test("missing images show their link and allow relinking without touching caption/layout props", async () => {
  read.mockRejectedValue(new Error("missing")); select.mockResolvedValue({ sourcePath: "figures/new.png", copied: false });
  await render();
  expect(container.textContent).toContain("그림을 불러올 수 없습니다");
  expect(container.textContent).toContain("figures/plot.png");
  await click("다시 연결");
  expect(updates).toEqual([{ sourcePath: "figures/new.png", url: "" }]);
});

test("Reload reads the same path again and does not change document props", async () => {
  read.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  await render(); expect(container.querySelector("img")?.src).toBe(first);
  await click("Reload"); expect(container.querySelector("img")?.src).toBe(second);
  expect(read).toHaveBeenCalledTimes(2); expect(updates).toEqual([]);
});

test("a restored missing image can be reloaded", async () => {
  read.mockRejectedValueOnce(new Error("missing")).mockResolvedValueOnce(second);
  await render(); await click("Reload"); expect(container.querySelector("img")?.src).toBe(second);
});

test("cancelled and failed selections preserve the existing image", async () => {
  read.mockResolvedValue(first); select.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("Import failed"));
  await render(); await click("다시 연결"); await click("다시 연결");
  expect(updates).toEqual([]); expect(container.querySelector("img")?.src).toBe(first);
  expect(container.textContent).toContain("Import failed");
});

test("legacy embedded images remain visible and can be relinked", async () => {
  select.mockResolvedValue({ sourcePath: "figures/new.png", copied: false });
  await render("", undefined, first); expect(container.querySelector("img")?.src).toBe(first);
  expect(read).not.toHaveBeenCalled(); await click("다시 연결");
  expect(updates).toEqual([{ sourcePath: "figures/new.png", url: "" }]);
});

test("late file picker and read responses cannot overwrite a switched document", async () => {
  let finishRead!: (url: string) => void;
  let finishSelect!: (selection: { sourcePath: string; copied: boolean }) => void;
  read.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; })).mockResolvedValue(second);
  select.mockImplementationOnce(() => new Promise((resolve) => { finishSelect = resolve; }));
  await render(); await click("다시 연결");
  await render("figures/b.png", "/project/documents/b.scholarpen.json");
  await act(async () => { finishRead(first); finishSelect({ sourcePath: "figures/old-selection.png", copied: false }); });
  expect(container.querySelector("img")?.src).toBe(second); expect(updates).toEqual([]);
});

test("relevant file changes reload only the image; unrelated changes do nothing", async () => {
  read.mockResolvedValueOnce(first).mockResolvedValue(second);
  await render();
  await act(async () => { sendUpdate({ projectPath: "/other", filePath: "/other/figures/plot.png" });
    sendUpdate({ projectPath: "/project", filePath: "/project/documents/a.scholarpen.json" });
    await new Promise((resolve) => setTimeout(resolve, 250)); });
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => { sendUpdate({ projectPath: "/project", filePath: "/project/figures/plot.png" });
    await new Promise((resolve) => setTimeout(resolve, 250)); });
  expect(read).toHaveBeenCalledTimes(2); expect(container.querySelector("img")?.src).toBe(second);
  expect(updates).toEqual([]);
});

test("decode failure has a recovery UI and Reload remounts the image", async () => {
  read.mockResolvedValue(first); await render();
  await act(async () => { container.querySelector("img")!.dispatchEvent(new dom.Event("error") as unknown as Event); });
  expect(container.textContent).toContain("그림을 불러올 수 없습니다");
  await click("Reload"); expect(container.querySelector("img")).not.toBeNull();
});


test("a mounted BlockNote figure receives its project context and retains its caption when relinked", async () => {
  const { BlockNoteEditor } = await import("@blocknote/core");
  const { BlockNoteViewRaw } = await import("@blocknote/react");
  const { scholarSchema } = await import("./schema");
  const editor = BlockNoteEditor.create({ schema: scholarSchema, initialContent: [{
    id: "mounted-figure", type: "figure", props: { sourcePath: "figures/plot.png", caption: "Keep caption",
      label: "fig-keep", width: "70%", figureNumber: 2 },
  }] });
  read.mockResolvedValue(first); select.mockResolvedValue({ sourcePath: "figures/relinked.png", copied: false });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(<FigureDocumentContext.Provider value={{ projectPath: "/project", documentPath: "/project/documents/a.scholarpen.json" }}>
    <BlockNoteViewRaw editor={editor} formattingToolbar={false} linkToolbar={false} slashMenu={false}
      emojiPicker={false} sideMenu={false} filePanel={false} tableHandles={false} comments={false} />
  </FigureDocumentContext.Provider>); });
  expect(read).toHaveBeenCalledWith("/project", "figures/plot.png");
  expect(container.querySelector("img")?.src).toBe(first);
  await click("다시 연결");
  expect(editor.document[0].props).toMatchObject({ sourcePath: "figures/relinked.png", caption: "Keep caption",
    label: "fig-keep", width: "70%", figureNumber: 2, url: "" });
  const snapshot = JSON.stringify(editor.document);
  await click("Reload"); expect(JSON.stringify(editor.document)).toBe(snapshot);
});
