import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import * as Y from "yjs";
import { AuthorLearning, parsePreferences } from "./learning";
import { collectAuthorObservations, collectMemorySources } from "./sources";
import { ProjectMemoryService, projectMemory } from "./hindsight";
import { ProjectMemorySync } from "./sync";
import { AUTHOR_EDITS_MAP, type AuthorObservation } from "../../shared/author-learning";

const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => { servers.splice(0).forEach(s => s.stop(true)); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), "author-learning-")); roots.push(path); return path; }
async function saveEdits(path: string, count = 3) {
  const doc = new Y.Doc();
  for (let i = 0; i < count; i++) doc.getMap(AUTHOR_EDITS_MAP).set(`edit-${i}`, { blockId: `p${i}`, before: `It is important to note that result ${i} supports this account.`, after: `Result ${i} supports this account.`, observedAt: 1 });
  doc.getMap("revisions").set("pending", { status: "pending", paragraphs: [{ blockId: "p9", before: "old", after: "AI proposal" }] });
  doc.getMap("revisions").set("applied", { status: "applied", paragraphs: [{ blockId: "p8", before: "old", after: "unreviewed AI text" }] });
  await mkdir(join(path, ".scholarpen/collab"), { recursive: true });
  await writeFile(join(path, ".scholarpen/collab/paper.scholarpen.json.ydoc"), Y.encodeStateAsUpdate(doc)); doc.destroy();
}
function preference(observations: AuthorObservation[]) {
  return JSON.stringify({ preferences: [{ rule: "불필요한 도입구를 생략한다", scope: "영문 원고의 문장 도입부", evidenceIds: observations.map(o => o.id) }] });
}

test("source collector excludes raw manuscripts, pending and unreviewed AI edits", async () => {
  const path = await root(); await saveEdits(path);
  await mkdir(join(path, "documents")); await writeFile(join(path, "documents/raw.scholarpen.json"), JSON.stringify([{ type: "paragraph", content: "The manuscript says something." }]));
  const observations = await collectAuthorObservations(path);
  expect(observations).toHaveLength(3);
  expect(observations.every(o => o.kind === "direct-edit")).toBeTrue();
  const sources = await collectMemorySources(path);
  expect(JSON.stringify(sources)).not.toContain("unreviewed AI text");
  expect(JSON.stringify(sources)).not.toContain("manuscript says");
});

test("preferences require three distinct passages and valid evidence IDs, not repeated keystrokes", async () => {
  const path = await root(); await saveEdits(path);
  const observations = await collectAuthorObservations(path);
  expect(parsePreferences(preference(observations), observations)).toHaveLength(1);
  expect(parsePreferences(preference(observations.slice(0, 2)), observations)).toHaveLength(0);
  expect(parsePreferences(preference(observations), observations.map(o => ({ ...o, blockId: "same" })))).toHaveLength(0);
  expect(parsePreferences(preference(observations), observations.map(o => ({ ...o, kind: "rejected" })))).toHaveLength(0);
  expect(parsePreferences(preference(observations), [])).toHaveLength(0);
  const bulkAcceptance: AuthorObservation[] = observations.map(o => ({ ...o, id: `paper:accepted:one-action:${o.blockId}`, kind: "accepted", direction: "Remove unnecessary introductions" }));
  expect(parsePreferences(preference(bulkAcceptance), bulkAcceptance)).toHaveLength(0);
  const independent = bulkAcceptance.map((o, i) => ({ ...o, id: `paper:accepted:action-${i}:${o.blockId}` }));
  expect(parsePreferences(preference(independent), independent)).toHaveLength(1);
});

test("inference persists across restart, reaches edit guidance, and dismissed interpretations stay excluded", async () => {
  const path = await root(); await saveEdits(path);
  const observations = await collectAuthorObservations(path); let calls = 0;
  const learner = new AuthorLearning(async () => { calls++; return preference(observations); });
  await learner.refresh(path); await learner.refresh(path);
  expect(calls).toBe(1);
  const restarted = new AuthorLearning(async () => { throw new Error("should not re-infer unchanged evidence"); });
  await restarted.refresh(path);
  expect(await restarted.guidance(path)).toContain("불필요한 도입구");
  expect(await restarted.guidance(path)).toContain("Current instructions");
  const view = await restarted.view(path);
  await restarted.dismiss(path, view.preferences[0].id); await restarted.refresh(path);
  expect(await restarted.guidance(path)).toBe("");
  expect((await restarted.view(path)).observations).toHaveLength(3);
});

test("offline retain and pending ingestion recover after restart without duplicates or premature completion", async () => {
  const path = await root(); await saveEdits(path, 1);
  let offline = true, completed = false, posts = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (offline) return new Response("offline", { status: 503 });
    const url = new URL(req.url);
    if (req.method === "PUT") return Response.json({ bank_id: url.pathname.split("/").at(-1) });
    if (url.pathname.endsWith("retain_async")) { posts++; const body = await req.json(); return Response.json({ success: true, bank_id: body.bank_id, operation_id: "operation-1" }); }
    if (url.pathname.includes("/operations/")) return Response.json({ status: completed ? "completed" : "processing" });
    return Response.json({});
  } }); servers.push(server);
  const client = () => new ProjectMemoryService(server.url.toString());
  await expect(new ProjectMemorySync(client()).sync(path)).rejects.toThrow();
  offline = false;
  await new ProjectMemorySync(client()).sync(path); expect(posts).toBe(1);
  let ledger = JSON.parse(await readFile(join(path, ".scholarpen/hindsight-sync.json"), "utf8"));
  expect(Object.values(ledger.sources)).toMatchObject([{ state: "processing" }]);
  await new ProjectMemorySync(client()).sync(path); expect(posts).toBe(1);
  completed = true;
  await new ProjectMemorySync(client()).sync(path); expect(posts).toBe(1);
  ledger = JSON.parse(await readFile(join(path, ".scholarpen/hindsight-sync.json"), "utf8"));
  expect(Object.values(ledger.sources)).toMatchObject([{ state: "completed" }]);
});

test("test preload disables production singleton, with no local binding or remote banks", async () => {
  const path = await root(); await projectMemory.initialize(path);
  expect((await projectMemory.status(path)).state).toBe("unavailable");
  expect(await Bun.file(join(path, ".scholarpen/hindsight.json")).exists()).toBeFalse();
});
