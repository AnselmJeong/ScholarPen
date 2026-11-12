import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorStyleService, resolveStyle } from "./service";
import { ProfileRepository } from "./profiles";
import type { PersonalStyleLibrary, StyleOperation, StyleView } from "../../../shared/author-style";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "personal-style-")); roots.push(root);
  const service = new AuthorStyleService(new ProfileRepository(root), { info: async () => ({ label: "offline-fixture", local: true }), complete: async () => { throw new Error("No AI should be called"); } });
  let library = await service.personal.read();
  const run = async (operation: StyleOperation, payload?: unknown, profileId?: string) => {
    library = await service.execute("", { scope: "personal", projectPath: "", operation, expectedRevision: library.revision, payload, profileId }, new AbortController().signal) as PersonalStyleLibrary;
    return library;
  };
  const create = async (name: string, language = "en", genre = "academic") => {
    await run("create", { name, language, genre }); const p = library.profiles.at(-1)!;
    await run("update", { name, rules: [{ id: `rule-${name}`, instruction: `Style ${name}`, language, genre, source: "explicit", status: "active", support: "author-confirmed", evidenceIds: [] }] }, p.id);
    return library.profiles.find(item => item.id === p.id)!;
  };
  return { root, service, run, create, get library() { return library; } };
}
test("personal rules persist independently and default resolution respects project, language and genre precedence", async () => {
  const f = await fixture(), global = await f.create("general", "any", "any"), scoped = await f.create("english"), korean = await f.create("korean", "ko");
  await f.run("setDefaults", { defaultProfileId: global.id, defaults: [{ language: "en", genre: "academic", profileId: scoped.id }, { language: "ko", genre: "academic", profileId: korean.id }] });
  const a = await f.service.repository.read("/project-A"), b = await f.service.repository.read("/project-B");
  expect(resolveStyle(a, { purpose: "draft", language: "en" }, f.library).application?.profileId).toBe(scoped.id);
  expect(resolveStyle(b, { purpose: "draft", language: "ko" }, f.library).application?.profileId).toBe(korean.id);
  expect(resolveStyle(b, { purpose: "draft", language: "fr", genre: "explanation" }, f.library).application?.profileId).toBe(global.id);
  a.profiles = [{ ...scoped, id: "project" }]; a.activeProfileId = "project";
  expect(resolveStyle(a, { purpose: "rewrite", language: "en" }, f.library).application?.profileId).toBe("project");
  expect(resolveStyle(a, { purpose: "rewrite", profileId: global.id, language: "en" }, f.library).application?.profileId).toBe(global.id);
  expect(resolveStyle(a, { purpose: "rewrite", profileId: "missing", language: "en" }, f.library).text).toBe("");
  expect(resolveStyle(a, { purpose: "rewrite", language: "ko" }, f.library).text).toBe("");
  const restarted = new AuthorStyleService(new ProfileRepository(f.root), { info: async () => ({ label: "offline", local: true }), complete: async () => "" });
  expect((await restarted.context(undefined, { purpose: "draft", language: "en" })).application?.profileId).toBe(scoped.id);
});
test("a personal link cannot fall back silently after deletion and deleting a default clears its bindings", async () => {
  const f = await fixture(), p = await f.create("linked"), fallback = await f.create("fallback", "any", "any");
  await f.run("setDefaults", { defaultProfileId: p.id, defaults: [{ language: "en", genre: "academic", profileId: p.id }] });
  let project = await f.service.view("/linked-project");
  project = await f.service.execute("/linked-project", { projectPath: "/linked-project", operation: "linkPersonal", expectedRevision: project.revision, payload: { id: p.id } }, new AbortController().signal) as StyleView;
  await f.run("delete", undefined, p.id); expect(f.library.defaultProfileId).toBeNull(); expect(f.library.defaults).toEqual([]);
  await f.run("setDefaults", { defaultProfileId: fallback.id, defaults: [] });
  expect((await f.service.context("/linked-project", { purpose: "rewrite", language: "en" })).text).toBe("");
  expect((await f.service.context("/new-project", { purpose: "rewrite", language: "en" })).application?.profileId).toBe(fallback.id);
});
test("publishing to personal copies approved rules only and never copies private examples or evidence IDs", async () => {
  const f = await fixture(); let state = await f.service.view("/private-project");
  const run = async (operation: StyleOperation, payload?: unknown) => { state = await f.service.execute("/private-project", { projectPath: "/private-project", operation, expectedRevision: state.revision, profileId: state.activeProfileId ?? undefined, payload }, new AbortController().signal) as StyleView; };
  await run("create", { name: "Project", language: "en", genre: "academic" });
  await run("addSample", { label: "private-origin", ownWriting: true, text: "This unpublished private passage must never enter the personal library or any other project." });
  await run("update", { name: "Project", rules: [{ id: "approved", instruction: "Prefer clear subjects", language: "en", genre: "academic", source: "explicit", status: "active", support: "author-confirmed", evidenceIds: [] }, { id: "candidate", instruction: "Unconfirmed", language: "en", genre: "academic", source: "learned", status: "candidate", support: "insufficient", evidenceIds: [] }] });
  await run("publishPersonal", { name: "Reusable", personalRevision: 0, confirmRulesOnly: true });
  const raw = await readFile(join(f.root, "personal.json"), "utf8"), library = await f.service.personal.read();
  expect(library.profiles[0]?.rules).toHaveLength(1); expect(library.profiles[0]?.rules[0]?.evidenceIds).toEqual([]);
  expect(raw).not.toContain("unpublished"); expect(raw).not.toContain("private-origin"); expect(raw).not.toContain(state.evidence[0]!.id); expect(raw).not.toContain("private-project");
  expect(state.evidence).toHaveLength(1);
});
test("personal scope rejects automatic observation and mismatched default bindings, stale edits cannot overwrite", async () => {
  const f = await fixture(), p = await f.create("English");
  await expect(f.run("observe", { text: "private" }, p.id)).rejects.toThrow("명시한 규칙");
  await expect(f.run("setDefaults", { defaultProfileId: null, defaults: [{ language: "ko", genre: "academic", profileId: p.id }] })).rejects.toThrow("범위");
  const revision = f.library.revision;
  const results = await Promise.allSettled([1, 2].map(() => f.service.personal.change(revision, s => { s.defaultProfileId = p.id; })));
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
});
test("personal restore creates a revision and corrupted library fails without overwriting", async () => {
  const f = await fixture(), p = await f.create("original");
  await f.run("update", { name: "renamed", rules: p.rules }, p.id);
  await f.run("restore", { revision: p.revision }, p.id); expect(f.library.profiles[0]?.name).toBe("original"); expect(f.library.profiles[0]!.revision).toBeGreaterThan(p.revision);
  await writeFile(join(f.root, "personal.json"), "{broken"); await expect(f.service.personal.read()).rejects.toThrow(); expect(await readFile(join(f.root, "personal.json"), "utf8")).toBe("{broken");
});
test("profiles from another local author cannot resolve", async () => {
  const f = await fixture(), p = await f.create("private"); await f.run("setDefaults", { defaultProfileId: p.id, defaults: [] });
  const project = await f.service.repository.read("/different"); project.authorId = "someone-else";
  expect(resolveStyle(project, { purpose: "draft", language: "en" }, f.library).text).toBe("");
});
