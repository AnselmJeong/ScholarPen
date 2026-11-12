import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { PROJECT_REVIEW_SETTINGS_KEY, REVIEW_MAP, REVIEW_CATEGORIES } from "../../../shared/collab/review";

import { controlByLabel, installDom } from "../../test-support/dom";
const env = installDom();
const dom = env.dom;
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const { rpc } = await import("../../rpc");
const { ProjectReviewOptions } = await import("./ProjectReviewOptions");
const save = spyOn(rpc, "collabSetReviewCategory");
let root: Root | undefined;
let container: HTMLDivElement;
const docs: Y.Doc[] = [];
function peer(docKey: string, disabledCategories: string[] = []) {
  const ydoc = new Y.Doc(); docs.push(ydoc);
  ydoc.getMap(REVIEW_MAP).set(PROJECT_REVIEW_SETTINGS_KEY, { disabledCategories });
  return { docKey, ydoc };
}
async function render(collab: ReturnType<typeof peer>) {
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(async () => root!.render(<ProjectReviewOptions key={collab.docKey} collab={collab} />));
}
function checkbox(label: string) { return controlByLabel(container, label)!; }
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; container?.remove();
  docs.splice(0).forEach(doc => doc.destroy()); save.mockReset();
});
afterAll(() => {
  save.mockRestore();
  env.restore();
});

test("one Citation option saves the project toggle and follows the server broadcast", async () => {
  const collab = peer("/project::one");
  save.mockImplementation(async (docKey, category, enabled) => {
    expect([docKey, category, enabled]).toEqual(["/project::one", "citation", false]);
    const settings = { disabledCategories: ["citation" as const] };
    collab.ydoc.getMap(REVIEW_MAP).set(PROJECT_REVIEW_SETTINGS_KEY, settings);
    return settings;
  });
  await render(collab);
  expect(container.querySelectorAll("input").length).toBe(REVIEW_CATEGORIES.length);
  expect(container.textContent).not.toContain("Needs citation");
  await act(async () => checkbox("Citation").click());
  expect(save).toHaveBeenCalledTimes(1);
  expect(checkbox("Citation").checked).toBe(false);
  expect(checkbox("Logic").checked).toBe(true);
  expect(container.textContent).toContain("12/13 on");
});

test("save failure keeps the current policy and displays an actionable error", async () => {
  save.mockRejectedValue(new Error("Project folder is read-only"));
  await render(peer("/project::one"));
  await act(async () => checkbox("Logic").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("read-only");
  expect(checkbox("Logic").checked).toBe(true);
  expect(container.querySelector("fieldset")?.disabled).toBe(false);
});

test("another editor broadcast updates the checklist; changing projects does not leak settings", async () => {
  const a = peer("/project-a::one");
  await render(a);
  await act(async () => a.ydoc.getMap(REVIEW_MAP).set(PROJECT_REVIEW_SETTINGS_KEY, { disabledCategories: ["logic"] }));
  expect(checkbox("Logic").checked).toBe(false);
  await render(peer("/project-b::one"));
  expect(checkbox("Logic").checked).toBe(true);
  expect(save).not.toHaveBeenCalled();
});
