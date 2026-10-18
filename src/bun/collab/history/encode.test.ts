import { expect, test } from "bun:test";
import * as Y from "yjs";
import { encodeCheckpoint } from "./encode";

test("a checkpoint carries only the deletions made since the previous one", () => {
  const doc = new Y.Doc();
  const text = doc.getText("t");
  // Many scattered deletions make the document's full delete set large.
  text.insert(0, "x".repeat(4_000));
  for (let i = 0; i < 1_000; i++) text.delete(i * 3, 1);
  const earlier = Y.encodeStateAsUpdate(doc);
  const since = Y.encodeStateVector(doc);
  const deletions: Array<Y.Transaction["deleteSet"]> = [];
  doc.on("afterTransaction", (tr: Y.Transaction) => { if (tr.deleteSet.clients.size) deletions.push(tr.deleteSet); });
  text.insert(0, "new ");
  text.delete(10, 2);

  const chunk = encodeCheckpoint(doc, since, Y.mergeDeleteSets(deletions));
  expect(chunk.length).toBeLessThan(Y.encodeStateAsUpdate(doc, since).length / 10);

  const replay = new Y.Doc();
  Y.applyUpdate(replay, Y.mergeUpdates([earlier, chunk]));
  expect(replay.getText("t").toString()).toBe(text.toString());
});
