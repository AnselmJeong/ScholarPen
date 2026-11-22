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
const { getHeadlessEditor } = await import("../collab/collab-peer");
const { settlePendingNodesTransaction } = await import("./suggestion-marks");
const { PENDING_NODE_MARK, pendingNodeText } = await import("../../shared/collab/pending-nodes");
const { schemaToSpecJSON } = await import("../../shared/collab/schema-spec");

const schema = getHeadlessEditor().pmSchema;

/** A paragraph holding a struck citation (change set 7), in the editor's real schema. */
function state() {
  const citation = schema.nodes.citation.create({ citekey: "kim2020", locator: "" });
  const paragraph = schema.nodes.paragraph.create(null, [
    schema.text("As shown "),
    pendingNodeText(citation, [schema.marks.deletion.create({ id: 7 })]),
    schema.text("."),
  ]);
  const block = schema.nodes.blockContainer.create({ id: "b1" }, [paragraph]);
  return EditorState.create({ schema, doc: schema.nodes.doc.create(null, [schema.nodes.blockGroup.create(null, [block])]) });
}

const citations = (doc: any) => {
  const keys: string[] = [];
  doc.descendants((node: any) => { if (node.type.name === "citation") keys.push(node.attrs.citekey); });
  return keys;
};

test("the schema shipped to Bun knows the pendingNode mark", () => {
  expect(schemaToSpecJSON(schema).marks.map(([name]) => name)).toContain(PENDING_NODE_MARK);
});

test("reverting a struck citation in this editor brings the node back; a peer's change is left to that peer", () => {
  const before = state();
  let from = 0;
  let to = 0;
  before.doc.descendants((node, pos) => {
    if (node.marks.some((mark) => mark.type.name === PENDING_NODE_MARK)) { from = pos; to = pos + node.nodeSize; }
  });
  const revert = before.tr.removeMark(from, to, schema.marks.deletion);
  const after = before.apply(revert);

  const settle = settlePendingNodesTransaction(after, [revert]);
  expect(settle).not.toBeNull();
  expect(citations(after.apply(settle!).doc)).toEqual(["kim2020"]);
  expect(after.apply(settle!).doc.textContent).toBe("As shown .");

  const remote = before.tr.removeMark(from, to, schema.marks.deletion).setMeta("y-sync$", { isChangeOrigin: true });
  expect(settlePendingNodesTransaction(before.apply(remote), [remote])).toBeNull();
  // Still pending: nothing to settle.
  const typing = before.tr.insertText("x", 1);
  expect(settlePendingNodesTransaction(before.apply(typing), [typing])).toBeNull();
});
