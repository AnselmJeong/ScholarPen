import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WritingPreferences } from "../../../shared/writing-preferences";
import { chooseOption, installDom, selectorTrigger } from "../../test-support/dom";
const env = installDom();
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const { rpc } = await import("../../rpc");
const { WritingPreferencesPanel } = await import("./WritingPreferencesPanel");
const get = spyOn(rpc, "getWritingPreferences"), save = spyOn(rpc, "saveWritingPreferences");
let root: Root | undefined, container: HTMLDivElement;
const AVOID = "피하기 · 문장 다시 구성", ALLOW = "허용 · 자동 제거 안 함";
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container?.remove(); get.mockReset(); save.mockReset(); });
afterAll(() => { get.mockRestore(); save.mockRestore(); env.restore(); });
async function render() {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<WritingPreferencesPanel />));
}
test("punctuation controls save independently without an extension or project", async () => {
  let value: WritingPreferences = { version: 1, revision: 0, punctuation: { emDash: "avoid", semicolon: "avoid" } };
  get.mockImplementation(async () => value);
  save.mockImplementation(async (revision, punctuation) => { value = { version: 1, punctuation, revision: revision + 1 }; return value; });
  await render();
  await chooseOption(container, "Em dash (—)", ALLOW, act);
  expect(value.punctuation).toEqual({ emDash: "allow", semicolon: "avoid" });
  expect(selectorTrigger(container, "세미콜론 (;)").textContent).toBe(AVOID);
  await chooseOption(container, "세미콜론 (;)", ALLOW, act);
  expect(value.punctuation).toEqual({ emDash: "allow", semicolon: "allow" });
  expect(save.mock.calls[1]![0]).toBe(1);
});
test("stale preference edits display the conflict and reload the saved setting", async () => {
  get.mockResolvedValueOnce({ version: 1, revision: 0, punctuation: { emDash: "avoid", semicolon: "avoid" } });
  get.mockResolvedValue({ version: 1, revision: 1, punctuation: { emDash: "avoid", semicolon: "allow" } });
  save.mockRejectedValue(new Error("설정이 변경되었습니다. 새로고침하세요."));
  await render();
  await chooseOption(container, "Em dash (—)", ALLOW, act);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("설정이 변경되었습니다");
  expect(selectorTrigger(container, "Em dash (—)").textContent).toBe(AVOID); expect(selectorTrigger(container, "세미콜론 (;)").textContent).toBe(ALLOW);
  expect(selectorTrigger(container, "Em dash (—)").getAttribute("aria-disabled")).not.toBe("true");
});
