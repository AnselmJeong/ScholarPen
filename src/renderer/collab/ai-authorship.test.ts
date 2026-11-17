import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

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

const { EditorState } = await import("prosemirror-state");
const { getHeadlessEditor } = await import("./collab-peer");
const { AIAuthorshipExtension } = await import("./ai-authorship");
const { blocksToScholarMarkdown } = await import("../blocks/markdown-serializer");
const { AI_AUTHORED_MARK, authorshipBlind, withAIAuthored } = await import("../../shared/collab/ai-authorship");

const editor = getHeadlessEditor();
const schema = editor.pmSchema;
const plugins = (AIAuthorshipExtension() as any)({ editor, options: {} }).prosemirrorPlugins;

function paragraph(id: string, parts: Array<{ text: string; ai?: boolean }>) {
  return schema.nodes.blockContainer.create({ id }, [schema.nodes.paragraph.create(null, parts.map((part) =>
    schema.text(part.text, part.ai ? withAIAuthored(schema) : [])))]);
}

function marked(state: InstanceType<typeof EditorState>) {
  const runs: string[] = [];
  state.doc.descendants((node) => {
    if (node.isText) runs.push(node.marks.some((mark) => mark.type.name === AI_AUTHORED_MARK) ? `[${node.text}]` : node.text!);
    return true;
  });
  return runs.join("");
}

function start() {
  const doc = schema.nodes.doc.create(null, [schema.nodes.blockGroup.create(null, [
    paragraph("p1", [{ text: "The author wrote this. " }, { text: "The AI wrote this.", ai: true }]),
  ])]);
  return EditorState.create({ schema, doc, plugins });
}

const posOf = (state: InstanceType<typeof EditorState>, text: string) => {
  let found = -1;
  state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text!.includes(text)) found = pos + node.text!.indexOf(text);
    return found < 0;
  });
  return found;
};

test("words the author types over AI text are theirs; the rest stays the AI's", () => {
  let state = start();
  const ai = posOf(state, "AI wrote");
  // Typing inside the AI's sentence inherits its marks, then loses the authorship mark.
  state = state.apply(state.tr.insertText("really ", ai + "AI ".length));
  expect(marked(state)).toBe("The author wrote this. [The AI ]really [wrote this.]");
  // Replacing an AI word by typing.
  const target = (() => { let p = -1; state.doc.descendants((node, pos) => { if (p < 0 && node.isText && node.text === "wrote this.") p = pos; return p < 0; }); return p; })();
  state = state.apply(state.tr.insertText("said", target, target + "wrote".length));
  expect(marked(state)).toBe("The author wrote this. [The AI ]really said[ this.]");
});

test("AI text written in this editor keeps its mark; moved blocks keep theirs", () => {
  let state = start();
  // An AI write (inline AI edit accepted) says so and keeps its mark.
  const end = posOf(state, "The AI");
  state = state.apply(state.tr.insertText("Indeed, ", end).setMeta("scholarpen-ai-authored", true)
    .addMark(end, end + "Indeed, ".length, schema.marks[AI_AUTHORED_MARK].create()));
  expect(marked(state)).toBe("The author wrote this. [Indeed, The AI wrote this.]");
  // A whole block re-inserted (restore, reconcile, move) is not typing.
  const block = state.doc.firstChild!.firstChild!;
  const size = state.doc.firstChild!.content.size;
  state = state.apply(state.tr.replaceWith(1, 1 + size, block));
  expect(marked(state)).toBe("The author wrote this. [Indeed, The AI wrote this.]");
});

test("a suggested insertion arriving in this editor is marked as the AI's", () => {
  let state = start();
  const at = posOf(state, "The author") + "The author".length;
  state = state.apply(state.tr.insertText(" carefully", at).addMark(at, at + " carefully".length, schema.marks.insertion.create({ id: 1 })));
  expect(marked(state)).toContain("The author[ carefully] wrote");
});

test("AI editing reads mixed authorship as one run of text", () => {
  const node = paragraph("p1", [{ text: "The author wrote this. " }, { text: "The AI wrote this.", ai: true }]).firstChild!;
  expect(node.childCount).toBe(2);
  expect(authorshipBlind(node).childCount).toBe(1);
  expect(authorshipBlind(node).textContent).toBe(node.textContent);
});

test("exports carry neither the authorship mark nor drafting placeholders", async () => {
  const markdown = await blocksToScholarMarkdown(editor as any, [
    { id: "a", type: "paragraph", props: {}, content: [{ type: "text", text: "Mine and ", styles: {} }, { type: "text", text: "the AI's", styles: { aiAuthored: true } }], children: [] },
    { id: "b", type: "aiPlaceholder", props: { intent: "Ethics approval", state: "pending", draft: "d" }, content: undefined, children: [] },
  ] as any, "md");
  expect(markdown.trim()).toBe("Mine and the AI's");
});
