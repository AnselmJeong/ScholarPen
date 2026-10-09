import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { OllamaMessage } from "../../../../shared/rpc-types";
import {
  asksForHumanize,
  changeRate,
  humanizeGuidance,
  isKoreanProse,
  parseHumanizeDiagnosis,
  sampleParagraphs,
} from "./humanize";
import { QUICK_RULES } from "./rulebook";

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

const { getHeadlessEditor } = await import("../../../../renderer/collab/collab-peer");
const { blocksToYDoc } = await import("@blocknote/core/yjs");
const Y = await import("yjs");
const { CollabRegistry } = await import("../../registry");
const { CollabAgent } = await import("../agent");
const { readDoc, findBlock, blockContent } = await import("../doc-model");
const { schemaToSpecJSON } = await import("../../../../shared/collab/schema-spec");
const { COLLAB_THREADS_MAP } = await import("../../../../shared/collab/protocol");
const { createThread, readThreads } = await import("../../../../shared/collab/threads");

const author = (text: string) => [{ author: "author" as const, text }];

test("comments that ask for the humanizer are recognised", () => {
  for (const text of ["/humanize", "im-not-ai skill을 써줘", "어투를 자연스레 해줘", "AI 티 좀 빼줘", "번역투 고쳐줘", "사람이 쓴 것처럼 윤문해줘"]) {
    expect(asksForHumanize(author(text))).toBe(true);
  }
  for (const text of ["Make the claims more cautious", "이 문단 근거를 보강해줘", "@AI 오타만 고쳐줘"]) {
    expect(asksForHumanize(author(text))).toBe(false);
  }
  // Only the author's words count, not the AI's replies.
  expect(asksForHumanize([{ author: "ai", text: "AI 티를 줄였습니다." }])).toBe(false);
});

test("only Korean prose is a target", () => {
  expect(isKoreanProse("본 연구는 인공지능 기술을 통해 진단 정확도를 높일 수 있음을 보여준다.")).toBe(true);
  expect(isKoreanProse("We used a GLM (p < 0.05) to model the outcome.")).toBe(false);
  expect(isKoreanProse("Figure 1. 결과")).toBe(false);
});

test("the change rate matches difflib's 1 − ratio", () => {
  expect(changeRate("같은 글", "같은 글")).toBe(0);
  expect(changeRate("abcd", "")).toBe(1);
  // LCS("abcd", "abxd") = 3 → 1 − 6/8
  expect(changeRate("abcd", "abxd")).toBeCloseTo(0.25);
});

test("long manuscripts are sampled across all sections for the diagnosis", () => {
  const texts = Array.from({ length: 100 }, (_, index) => `${index}:${"가".repeat(998)}`);
  const sample = sampleParagraphs(texts, 20_000);
  expect(sample.reduce((sum, text) => sum + text.length, 0)).toBeLessThanOrEqual(20_000);
  expect(sample.some((text) => text.startsWith("9"))).toBe(true);
  expect(sample.at(-1)!.startsWith("9")).toBe(true);
  expect(sampleParagraphs(["짧은 글"], 20_000)).toEqual(["짧은 글"]);
});

test("a diagnosis is parsed defensively", () => {
  const diagnosis = parseHumanizeDiagnosis('<think>x</think>{"genre":"학술","register":"한다체","patterns":[' +
    '{"id":"A-15","name":"추상 주어","why":"…","fix":"…"},{"id":"bogus","name":"x"}],"preserve":["절 제목"],"summary":"요약"}');
  expect(diagnosis).toMatchObject({ register: "한다체", preserve: ["절 제목"], summary: "요약" });
  expect(diagnosis!.patterns.map((pattern) => pattern.id)).toEqual(["A-15"]);
  expect(parseHumanizeDiagnosis("no json here")).toBeNull();
  expect(humanizeGuidance(diagnosis)).toContain("A-15 추상 주어");
  expect(humanizeGuidance(null)).toContain(QUICK_RULES.slice(0, 40));
});

// ── The humanizer as a manuscript-wide comment ─────────────────────────────

const editor = getHeadlessEditor();
const BLOCKS = [
  { id: "h", type: "heading", props: { level: 2 }, content: "연구 방법에 대한 고찰" },
  { id: "k1", type: "paragraph", content: "본 연구는 인공지능 기술을 통해 진단 정확도를 높일 수 있음을 보여준다." },
  { id: "en", type: "paragraph", content: "Data were analysed with a mixed model." },
  { id: "k2", type: "paragraph", content: "결론적으로, 이러한 결과는 임상 현장에 시사하는 바가 크다." },
  { id: "k3", type: "paragraph", content: "참가자들은 두 집단에 무작위로 배정되었으며 추적 관찰은 6개월 동안 진행되었다." },
];

let registry: InstanceType<typeof CollabRegistry>;
let agent: InstanceType<typeof CollabAgent> | null = null;
afterEach(async () => {
  agent?.dispose();
  agent = null;
  await registry?.dispose();
});

const isDiagnosis = (messages: OllamaMessage[]) => (messages[0].content as string).includes("diagnosing AI-generated Korean prose");
const isPlan = (messages: OllamaMessage[]) => (messages[0].content as string).includes("list every paragraph");

test("a humanize comment diagnoses once and rewrites every Korean paragraph, gating over-polished ones", async () => {
  const seeded = blocksToYDoc(editor, BLOCKS as any, "document-store");
  registry = new CollabRegistry({
    read: async () => ({ state: Y.encodeStateAsUpdate(seeded), meta: { jsonHash: "h", updatedAt: 0 } }),
    write: async () => {},
    jsonHash: async () => "h",
  }, { update: () => {}, awareness: () => {} });
  await registry.open({ projectPath: "/p", filename: "doc.scholarpen.json", peerId: "editor", schema: schemaToSpecJSON(editor.pmSchema) });
  const session = registry.get("/p::doc.scholarpen.json")!;
  const prompts: OllamaMessage[][] = [];
  agent = new CollabAgent(registry, {
    complete: async (messages) => {
      prompts.push(messages);
      if (isDiagnosis(messages)) {
        return JSON.stringify({ genre: "학술", register: "한다체", summary: "번역투(A-2)와 의의 과장(D-2)이 두드러집니다.", preserve: [],
          patterns: [{ id: "A-2", name: "~를 통해 남발", why: "기술을 통해", fix: "도구격 조사로" }] });
      }
      const passage = (messages[1].content as string).match(/<passage_to_edit>\n([\s\S]*?)\n<\/passage_to_edit>/)![1];
      return "<reply>A-2, D-2를 고쳤습니다.</reply><passage>" + passage
        .replace("인공지능 기술을 통해", "인공지능 기술로")
        .replace("결론적으로, 이러한 결과는 임상 현장에 시사하는 바가 크다.", "결과는 임상에서 쓸모가 있다.")
        .replace("참가자들은 두 집단에 무작위로 배정되었으며", "참가자를 두 집단에 무작위로 나눴고") + "</passage>";
    },
    onActivity: () => {},
    pollMs: 10,
  });

  let threadId = "";
  session.ydoc.transact(() => {
    threadId = createThread(session.ydoc.getMap(COLLAB_THREADS_MAP), "me", "im-not-ai로 어투를 자연스럽게 해줘",
      { assignee: "ai", status: "open", scope: "document" });
  }, "editor");
  const threadOf = () => readThreads(session.ydoc.getMap(COLLAB_THREADS_MAP)).find((t) => t.id === threadId)!;
  for (let i = 0; i < 300 && threadOf().comments.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));

  // No planning call: the diagnosis replaces it, and the rewrite carries rulebook and diagnosis.
  expect(prompts.some(isPlan)).toBe(false);
  expect(prompts.filter(isDiagnosis)).toHaveLength(1);
  const edit = prompts.find((messages) => !isDiagnosis(messages))!;
  expect(edit[0].content).toContain("<rulebook>");
  expect(edit[0].content).toContain("A-2 ~를 통해 남발");
  const passage = edit[1].content as string;
  expect(passage).toContain("인공지능 기술을 통해");
  expect(passage.match(/<passage_to_edit>[\s\S]*<\/passage_to_edit>/)![0]).not.toContain("mixed model");
  expect(passage.match(/<passage_to_edit>[\s\S]*<\/passage_to_edit>/)![0]).not.toContain("고찰");

  // Text of a block, including suggested insertions (minor edits land directly in auto mode).
  const text = (blockId: string) => blockContent(findBlock(readDoc(session), blockId)!).node.textContent;
  expect(text("k1")).toContain("인공지능 기술로");
  expect(text("k3")).toContain("나눴고");
  // k2 was rewritten by more than half, so it stays as written.
  expect(text("k2")).toBe(BLOCKS[3].content as string);

  const reply = threadOf().comments[1].text;
  expect(reply).toContain("번역투(A-2)와 의의 과장(D-2)이 두드러집니다.");
  expect(reply).toContain("over-polishing");
  expect(reply).toMatch(/Change rate \d+% on average/);
  expect(threadOf().meta).toMatchObject({ status: "proposed", assignee: "me" });
});

test("English-majority Humanize uses blader rules and preserves Korean paragraphs, citations and formatting", async () => {
  const original = "These results play a crucial role in our understanding of the sample. We analysed participant responses and measured changes over time. The evidence supports further research and does not establish a causal link. ";
  const seeded = blocksToYDoc(editor, [
    { id: "heading", type: "heading", content: "Study findings" },
    { id: "english", type: "paragraph", content: [
      { type: "text", text: original, styles: { bold: true } },
      { type: "citation", props: { citekey: "smith2026" } },
    ] },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `kr${i}`, type: "paragraph", content: "연구 결과를 설명한다." })),
  ] as any, "document-store");
  registry = new CollabRegistry({
    read: async () => ({ state: Y.encodeStateAsUpdate(seeded), meta: { jsonHash: "h", updatedAt: 0 } }),
    write: async () => {}, jsonHash: async () => "h",
  }, { update: () => {}, awareness: () => {} });
  await registry.open({ projectPath: "/p", filename: "english.scholarpen.json", peerId: "editor", schema: schemaToSpecJSON(editor.pmSchema) });
  const session = registry.get("/p::english.scholarpen.json")!;
  const prompts: OllamaMessage[][] = [];
  agent = new CollabAgent(registry, {
    complete: async messages => {
      prompts.push(messages);
      const passage = (messages[1].content as string).match(/<passage_to_edit>\n([\s\S]*?)\n<\/passage_to_edit>/)![1];
      expect(passage).not.toContain("연구 결과");
      expect(passage).not.toContain("Study findings");
      return `<reply>Removed inflated significance.</reply><passage>${passage.replace("play a crucial role in our understanding of", "help explain")}</passage>`;
    }, onActivity: () => {}, pollMs: 10,
  });
  const id = createThread(session.ydoc.getMap(COLLAB_THREADS_MAP), "me", "/humanize", { assignee: "ai", status: "open", scope: "document" });
  const threadOf = () => readThreads(session.ydoc.getMap(COLLAB_THREADS_MAP)).find(t => t.id === id)!;
  for (let i = 0; i < 300 && threadOf().comments.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(prompts).toHaveLength(1);
  expect(prompts[0][0].content).toContain("blader/humanizer");
  expect(prompts.some(isDiagnosis)).toBe(false);
  const { EditorState } = await import("prosemirror-state");
  const { applySuggestions, revertSuggestions } = await import("@handlewithcare/prosemirror-suggest-changes");
  let accepted = readDoc(session), rejected = accepted;
  applySuggestions(EditorState.create({ schema: session.schema, doc: accepted }), tr => { accepted = tr.doc; });
  revertSuggestions(EditorState.create({ schema: session.schema, doc: rejected }), tr => { rejected = tr.doc; });
  const revised = blockContent(findBlock(accepted, "english")!).node;
  expect(revised.textContent).toContain("These results help explain the sample.");
  expect(revised.firstChild!.marks.some(mark => mark.type.name === "bold")).toBe(true);
  expect(revised.lastChild!.attrs.citekey).toBe("smith2026");
  expect(blockContent(findBlock(rejected, "english")!).node.firstChild!.text).toBe(original);
  expect(blockContent(findBlock(accepted, "kr0")!).node.textContent).toBe("연구 결과를 설명한다.");
  expect(threadOf().meta).toMatchObject({ status: "proposed", changeSet: expect.any(Number) });
  expect(threadOf().comments[1].text).toContain("English manuscript detected");
});

test("the slash menu keeps Humanize independent from watermark removal", async () => {
  const { getScholarSlashMenuItems } = await import("../../../../renderer/blocks/slash-menu-items");
  let requested = false;
  let watermarkRequested = false;
  const items = getScholarSlashMenuItems(editor as any, () => {}, () => {}, () => { requested = true; }, () => { watermarkRequested = true; });
  const action = items.find(item => item.title === "Humanize")!;
  expect(action.aliases).toContain("humanize");
  expect(action.aliases).not.toContain("watermark");
  expect(action.subtext).toContain("영어");
  action.onItemClick();
  expect(requested).toBe(true);
  expect(watermarkRequested).toBe(false);
  const watermark = items.find(item => item.title === "Remove watermark")!;
  expect(watermark.subtext).toContain("현재 문서 전체");
  watermark.onItemClick();
  expect(watermarkRequested).toBe(true);
  expect(asksForHumanize(author("/remove watermark"))).toBe(false);
});

test("explicit document Humanize processes the tail beyond 200 paragraphs without a selection or planning cap", async () => {
  const blocks = Array.from({ length: 205 }, (_, i) => ({
    id: `long-${i}`, type: "paragraph", content: `문단번호${i} 연구 결과를 정확하게 설명한다.`,
  }));
  const seeded = blocksToYDoc(editor, blocks as any, "document-store");
  registry = new CollabRegistry({
    read: async () => ({ state: Y.encodeStateAsUpdate(seeded), meta: { jsonHash: "h", updatedAt: 0 } }),
    write: async () => {}, jsonHash: async () => "h",
  }, { update: () => {}, awareness: () => {} });
  await registry.open({ projectPath: "/p", filename: "long.scholarpen.json", peerId: "editor", schema: schemaToSpecJSON(editor.pmSchema) });
  const session = registry.get("/p::long.scholarpen.json")!;
  const visited = new Set<number>();
  agent = new CollabAgent(registry, {
    complete: async messages => {
      if (isDiagnosis(messages)) return '{"patterns":[],"preserve":[]}';
      expect(isPlan(messages)).toBe(false);
      const passage = String(messages[1].content).match(/<passage_to_edit>\n([\s\S]*?)\n<\/passage_to_edit>/)![1];
      for (const match of passage.matchAll(/문단번호(\d+)/g)) visited.add(Number(match[1]));
      return '<reply>확인했습니다.</reply><passage>NO_CHANGE</passage>';
    }, onActivity: () => {}, pollMs: 5,
  });
  const id = createThread(session.ydoc.getMap(COLLAB_THREADS_MAP), "me", "문서를 다듬어 주세요.", {
    assignee: "ai", status: "open", documentAction: "humanize",
  });
  for (let i = 0; i < 300 && !readThreads(session.ydoc.getMap(COLLAB_THREADS_MAP)).find(t => t.id === id)?.comments[1]; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(visited.size).toBe(205);
  expect(visited.has(204)).toBe(true);
});
