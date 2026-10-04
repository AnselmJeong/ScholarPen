import { afterEach, expect, test } from "bun:test";
import * as Y from "yjs";
import { Schema } from "prosemirror-model";
import { fromBase64, toBase64 } from "lib0/buffer";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { CollabRegistry, type CollabMeta, type CollabStorage } from "./registry";
import { COLLAB_FRAGMENT, type CollabUpdateMessage } from "../../shared/collab/protocol";
import { schemaToSpecJSON } from "../../shared/collab/schema-spec";

const schema = schemaToSpecJSON(new Schema({
  nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} },
}));

function memoryStorage() {
  const files = new Map<string, { state: Uint8Array; meta: CollabMeta }>();
  const jsonHashes = new Map<string, string>();
  const storage: CollabStorage = {
    async read(projectPath, filename) {
      const file = files.get(`${projectPath}/${filename}`);
      return { state: file?.state ?? null, meta: file?.meta ?? null };
    },
    async write(projectPath, filename, state, meta) {
      files.set(`${projectPath}/${filename}`, { state, meta });
    },
    async jsonHash(projectPath, filename) {
      return jsonHashes.get(`${projectPath}/${filename}`) ?? null;
    },
  };
  return { storage, files, jsonHashes };
}

let registry: CollabRegistry | null = null;
afterEach(async () => {
  await registry?.dispose();
  registry = null;
});

function setup() {
  const memory = memoryStorage();
  const updates: CollabUpdateMessage[] = [];
  const awareness: CollabUpdateMessage[] = [];
  registry = new CollabRegistry(memory.storage, {
    update: (message) => updates.push(message),
    awareness: (message) => awareness.push(message),
  });
  return { ...memory, updates, awareness, registry };
}

function peerDoc(state: string) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, fromBase64(state));
  return doc;
}

function writeParagraph(doc: Y.Doc, text: string) {
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment(COLLAB_FRAGMENT).push([paragraph]);
}

test("first peer seeds an empty document and later peers receive the seeded state", async () => {
  const { registry, updates } = setup();
  const first = await registry.open({ projectPath: "/p", filename: "a.scholarpen.json", peerId: "A", schema });
  expect(first.bootstrap).toBe("seed");

  const secondOpen = registry.open({ projectPath: "/p", filename: "a.scholarpen.json", peerId: "B", schema });
  const docA = peerDoc(first.state);
  const seeded: Uint8Array[] = [];
  docA.on("update", (update: Uint8Array) => seeded.push(update));
  writeParagraph(docA, "hello");
  registry.push(first.docKey, "A", toBase64(Y.mergeUpdates(seeded)));

  const second = await secondOpen;
  expect(second.bootstrap).toBe("none");
  expect(peerDoc(second.state).getXmlFragment(COLLAB_FRAGMENT).toString()).toBe("<paragraph>hello</paragraph>");
  expect(updates.at(-1)?.origin).toBe("A");
});

test("state persists after the last peer closes and is reused on reopen", async () => {
  const { registry, files, jsonHashes } = setup();
  const opened = await registry.open({ projectPath: "/p", filename: "a.scholarpen.json", peerId: "A", schema });
  const doc = peerDoc(opened.state);
  const updates: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => updates.push(update));
  writeParagraph(doc, "persisted");
  registry.push(opened.docKey, "A", toBase64(Y.mergeUpdates(updates)));
  await registry.noteJsonSaved("/p", "a.scholarpen.json", "hash-1");
  jsonHashes.set("/p/a.scholarpen.json", "hash-1");
  await registry.close(opened.docKey, "A");

  expect(registry.get(opened.docKey)).toBeUndefined();
  expect(files.get("/p/a.scholarpen.json")?.meta.jsonHash).toBe("hash-1");

  const reopened = await registry.open({ projectPath: "/p", filename: "a.scholarpen.json", peerId: "B", schema });
  expect(reopened.bootstrap).toBe("none");
  expect(peerDoc(reopened.state).getXmlFragment(COLLAB_FRAGMENT).toString()).toBe("<paragraph>persisted</paragraph>");

  // Someone rewrote the JSON outside the editor: the peer must reconcile.
  await registry.close(reopened.docKey, "B");
  jsonHashes.set("/p/a.scholarpen.json", "hash-2");
  const changed = await registry.open({ projectPath: "/p", filename: "a.scholarpen.json", peerId: "C", schema });
  expect(changed.bootstrap).toBe("reconcile");
});

test("awareness from a closed peer is removed for everyone else", async () => {
  const { registry, awareness } = setup();
  const opened = await registry.open({ projectPath: "/p", filename: "a.scholarpen.json", peerId: "A", schema });
  const doc = peerDoc(opened.state);
  const seed: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => seed.push(update));
  writeParagraph(doc, "seed");
  registry.push(opened.docKey, "A", toBase64(Y.mergeUpdates(seed)));
  const presence = new Awareness(doc);
  presence.setLocalState({ user: { name: "me" } });
  registry.pushAwareness(opened.docKey, "A", toBase64(encodeAwarenessUpdate(presence, [doc.clientID])));
  expect(registry.get(opened.docKey)?.awareness.getStates().has(doc.clientID)).toBe(true);

  await registry.open({ projectPath: "/p", filename: "a.scholarpen.json", peerId: "B", schema });
  await registry.close(opened.docKey, "A");
  const observer = new Awareness(new Y.Doc());
  applyAwarenessUpdate(observer, fromBase64(awareness.at(-1)!.update), "test");
  expect(registry.get(opened.docKey)?.awareness.getStates().has(doc.clientID)).toBe(false);
  presence.destroy();
  observer.destroy();
});
