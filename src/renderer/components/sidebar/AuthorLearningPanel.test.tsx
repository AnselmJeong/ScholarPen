import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
const dom = new Window({ url: "http://localhost" });
const keys = ["window", "document", "navigator", "HTMLElement", "Event", "CustomEvent", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const { rpc } = await import("../../rpc");
const { AuthorLearningPanel } = await import("../../../plugins/author-style/ui/AuthorLearningPanel");
const { PersonalProfilesPanel } = await import("../../../plugins/author-style/ui/PersonalProfilesPanel");
const invoke = spyOn(rpc, "extensionsInvoke");
let root: Root | undefined, container: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container?.remove(); invoke.mockReset(); });
afterAll(() => { invoke.mockRestore(); for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key); void dom.happyDOM.abort(); });
const { DEFAULT_STYLE_CONFIG } = await import("../../../shared/author-style");
function view(name = "한국어 학술문") {
  return { schemaVersion: 1, revision: 3, authorId: "local", activeProfileId: "profile-1", config: { ...DEFAULT_STYLE_CONFIG },
    profiles: [{ id: "profile-1", name, authorId: "local", revision: 1, language: "ko", genre: "academic", createdAt: "now", updatedAt: "now",
      rules: [{ id: "rule-1", instruction: "도입구를 생략한다", language: "ko", genre: "academic", source: "learned", status: "candidate", support: "insufficient", evidenceIds: ["sample-1"] }] }],
    evidence: [{ id: "sample-1", profileId: "profile-1", authorId: "local", kind: "author-sample", label: "본인 글", language: "ko", genre: "academic", text: "내가 직접 쓴 문장", hash: "hash", observedAt: 1 }],
    exclusions: [], history: [], applications: [], migration: null, lastAnalysisHash: "", provider: "fixture-local", localProvider: true, remoteDeletionPending: false };
}
async function render(path = "/project") {
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(async () => root!.render(<AuthorLearningPanel key={path} projectPath={path} />));
}
test("Style Studio shows scoped evidence, requires explicit approval, and persists through the generic gateway", async () => {
  let current = view();
  invoke.mockImplementation(async request => {
    const args = request.args as { operation: string; payload?: { rules: typeof current.profiles[0]["rules"] } };
    if (args.operation === "update") current = { ...current, revision: 4, profiles: [{ ...current.profiles[0]!, rules: args.payload!.rules }] };
    return current;
  });
  await render();
  expect(container.textContent).toContain("승인 필요"); expect(container.textContent).toContain("본인 글");
  expect(container.textContent).toContain("fixture-local");
  const approve = Array.from(container.querySelectorAll("button")).find(b => b.textContent === "승인")!;
  await act(async () => approve.click());
  expect(invoke.mock.calls.some(([r]) => (r.args as { operation: string }).operation === "update")).toBeTrue();
  expect(container.textContent).toContain("적용 중");
});
test("switching projects ignores a late profile response and remote deletion is shown honestly", async () => {
  let release!: (value: unknown) => void;
  invoke.mockImplementation(request => (request.args as { projectPath: string }).projectPath === "/old"
    ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ...view("새 프로젝트 문체"), remoteDeletionPending: true }));
  await render("/old"); await render("/new");
  await act(async () => release(view("이전 프로젝트 문체")));
  expect(container.textContent).toContain("새 프로젝트 문체"); expect(container.textContent).not.toContain("이전 프로젝트 문체");
  expect(container.textContent).toContain("삭제가 대기 중");
});
test("personal defaults can be edited without a project and scoped defaults keep their language and genre", async () => {
  const profile = view().profiles[0]!;
  let library = { schemaVersion: 1, revision: 1, authorId: "local", profiles: [profile], defaultProfileId: null as string | null,
    defaults: [] as { language: string; genre: string; profileId: string }[], history: [] };
  invoke.mockImplementation(async request => {
    const args = request.args as { scope: string; projectPath: string; operation: string; payload?: Partial<typeof library> };
    expect(args.scope).toBe("personal"); expect(args.projectPath).toBe("");
    if (args.operation === "setDefaults") library = { ...library, ...args.payload, revision: library.revision + 1 };
    return library;
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<PersonalProfilesPanel />));
  const select = container.querySelector<HTMLSelectElement>('[aria-label="개인 전역 기본 프로필"]')!;
  await act(async () => { select.value = profile.id; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(library.defaultProfileId).toBe(profile.id);
  const bind = Array.from(container.querySelectorAll("button")).find(b => b.textContent === "이 언어·장르의 기본으로 설정")!;
  await act(async () => bind.click());
  expect(library.defaults).toEqual([{ language: "ko", genre: "academic", profileId: profile.id }]);
  expect(container.textContent).toContain("ko/academic → 한국어 학술문");
});
