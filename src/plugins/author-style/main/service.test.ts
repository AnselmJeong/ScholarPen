import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileRepository, sampleProse } from "./profiles";
import { AuthorStyleService, resolveStyle } from "./service";
import type { StyleCommand, StyleView } from "../../../shared/author-style";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture(local = true) {
  const root = await mkdtemp(join(tmpdir(), "style-profile-")); roots.push(root);
  const path = join(root, "paper"), privateRoot = join(root, "private"); await mkdir(path);
  let response = '{"preferences":[],"sampleRules":[]}', calls = 0;
  const repo = new ProfileRepository(privateRoot);
  const service = new AuthorStyleService(repo, { info: async () => ({ label: local ? "local-fixture" : "remote-fixture", local }),
    complete: async () => { calls++; return response; } });
  let view = await service.view(path);
  const run = async (operation: StyleCommand["operation"], payload?: unknown, id = view.activeProfileId ?? undefined) => {
    const result = await service.execute(path, { projectPath: path, operation, expectedRevision: view.revision, profileId: id, payload }, new AbortController().signal);
    if ("config" in result) view = result;
    return result;
  };
  const create = async (language = "en", genre = "academic") => { await run("create", { name: "My prose", language, genre }); return view.profiles.at(-1)!; };
  const explicit = async () => { const p = view.profiles[0]!; await run("update", { name: p.name, rules: [{ id: "rule-1", instruction: "Prefer precise verbs.", language: p.language, genre: p.genre, source: "explicit", status: "active", support: "author-confirmed", evidenceIds: [] }] }); };
  return { root, path, privateRoot, repo, service, run, create, explicit, get view() { return view; }, get calls() { return calls; }, respond: (s: string) => { response = s; } };
}

test("new projects are private and opt-in, profiles survive restart with optimistic revision protection", async () => {
  const f = await fixture(); expect(f.view.config).toMatchObject({ observe: false, autoAnalyze: false, localOnly: true, remoteConsent: false });
  await f.create(); await f.explicit();
  const reopened = await new ProfileRepository(f.privateRoot).read(f.path);
  expect(reopened.profiles[0]?.rules[0]?.instruction).toBe("Prefer precise verbs.");
  expect(await readdir(f.path)).toEqual([]);
  await expect(f.service.execute(f.path, { projectPath: f.path, operation: "delete", expectedRevision: 0 }, new AbortController().signal)).rejects.toThrow("변경");
  expect((await f.repo.read(f.path)).profiles).toHaveLength(1);
});
test("resolver separates language, genre, project, analysis and chat while keeping approved rules offline", async () => {
  const f = await fixture(); await f.create(); await f.explicit();
  for (const purpose of ["extract", "review-evaluate", "style-learn", "chat"] as const) expect(resolveStyle(f.view, { purpose }).text).toBe("");
  expect(resolveStyle(f.view, { purpose: "rewrite", language: "ko" }).text).toBe("");
  expect(resolveStyle(f.view, { purpose: "rewrite", language: "en", genre: "explanation" }).text).toBe("");
  expect(resolveStyle(f.view, { purpose: "rewrite", language: "en", strength: "off" }).text).toBe("");
  const context = resolveStyle(f.view, { purpose: "rewrite", language: "en", genre: "academic" });
  expect(context.application?.ruleIds).toEqual(["rule-1"]); expect(context.text).toContain("Preserve meaning");
  const other = await f.repo.read(join(f.root, "another-project")); expect(resolveStyle(other, { purpose: "draft" }).text).toBe("");
  expect(f.calls).toBe(0);
});
test("sample rules stay candidates until explicit approval, raw samples never enter writing context", async () => {
  const f = await fixture(); const p = await f.create();
  const sample = "This privately authored example provides a distinct discussion of scientific uncertainty.";
  await f.run("addSample", { text: sample, label: "Own writing", ownWriting: true });
  f.respond(JSON.stringify({ preferences: [], sampleRules: [{ rule: "Qualify uncertainty.", evidenceIds: [f.view.evidence[0]!.id] }] }));
  await f.run("analyze"); expect(f.view.profiles[0]?.rules[0]?.status).toBe("candidate");
  expect(resolveStyle(f.view, { purpose: "rewrite" }).text).toBe("");
  await f.run("update", { name: p.name, rules: f.view.profiles[0]!.rules.map(r => ({ ...r, status: "active" })) });
  const context = resolveStyle(f.view, { purpose: "rewrite" }); expect(context.text).toContain("Qualify uncertainty"); expect(context.text).not.toContain(sample);
  expect(f.view.profiles[0]?.rules[0]?.support).toBe("author-confirmed");
});
test("remote analysis is blocked before network until consent, failure keeps prior approved profile", async () => {
  const f = await fixture(false); await f.create(); await f.explicit();
  await f.run("addSample", { text: "The author wrote this original example for analysis of cautious scientific wording.", label: "sample", ownWriting: true });
  await expect(f.run("analyze")).rejects.toThrow("원격"); expect(f.calls).toBe(0);
  await f.run("configure", { ...f.view.config, localOnly: false, remoteConsent: true });
  f.respond("broken JSON"); await expect(f.run("analyze")).rejects.toThrow();
  expect((await f.repo.read(f.path)).profiles[0]?.rules[0]?.instruction).toBe("Prefer precise verbs.");
});
test("evidence deletion removes derived rules in history but preserves explicit rules", async () => {
  const f = await fixture(); const p = await f.create(); await f.explicit();
  await f.run("addSample", { text: "This authored sample is long enough to support a candidate about concise explanations.", label: "sample", ownWriting: true });
  const id = f.view.evidence[0]!.id;
  f.respond(JSON.stringify({ preferences: [], sampleRules: [{ rule: "Use concise transitions.", evidenceIds: [id] }] })); await f.run("analyze");
  await f.run("update", { name: p.name, rules: f.view.profiles[0]!.rules.map(r => ({ ...r, status: "active" })) });
  await f.run("forgetEvidence", { id });
  expect(f.view.evidence).toHaveLength(0);
  expect(f.view.profiles[0]!.rules.map(r => r.instruction)).toEqual(["Prefer precise verbs."]);
  expect(JSON.stringify(f.view.history)).not.toContain("Use concise transitions.");
});
test("explicit portable packages omit paths, IDs and samples by default; imports require approval", async () => {
  const f = await fixture(); await f.create(); await f.explicit();
  const result = await f.run("export") as { package: string };
  expect(result.package).not.toContain(f.path); expect(result.package).not.toContain(f.view.authorId); expect(JSON.parse(result.package).samples).toEqual([]);
  await f.run("import", { package: result.package });
  expect(f.view.profiles).toHaveLength(2); expect(f.view.profiles[1]?.rules[0]?.status).toBe("candidate");
  await expect(f.run("import", { package: '{"schemaVersion":99}' })).rejects.toThrow();
});
test("concurrent mutations reject stale revisions, restore creates a new revision", async () => {
  const f = await fixture(); await f.create(); await f.explicit();
  const p = f.view.profiles[0]!; await f.run("update", { name: "Renamed", rules: p.rules });
  await f.run("restore", { revision: p.revision });
  expect(f.view.profiles[0]!.name).toBe("My prose"); expect(f.view.profiles[0]!.revision).toBeGreaterThan(p.revision);
  const current = f.view.revision;
  const writes = await Promise.allSettled([1, 2].map(() => f.repo.change(f.path, current, s => { s.config.observe = true; })));
  expect(writes.filter(r => r.status === "rejected")).toHaveLength(1);
});
test("migration backs up legacy preferences once and scopes approved rules by language", async () => {
  const f = await fixture(); const legacyProject = join(f.root, "legacy"); await mkdir(join(legacyProject, ".scholarpen"), { recursive: true });
  const observations = [1, 2, 3].map(n => ({ id: `edit-${n}`, filename: "paper", blockId: `p${n}`, kind: "direct-edit" as const, before: "It is important to note a result.", after: "A result supports the hypothesis.", direction: "", observedAt: 1 }));
  const raw = JSON.stringify({ version: 1, hash: "x", preferences: [{ id: "old", rule: "Avoid filler", scope: "English", evidenceIds: observations.map(o => o.id) }], excludedEvidence: [] });
  const file = join(legacyProject, ".scholarpen/author-preferences.json"); await writeFile(file, raw);
  const repo = new ProfileRepository(f.privateRoot, async () => observations);
  const state = await repo.read(legacyProject); expect(state.profiles[0]?.rules[0]?.status).toBe("active"); expect(state.config.observe).toBeTrue(); expect(state.config.remoteConsent).toBeFalse();
  expect(await readFile(file, "utf8")).toBe(raw); expect(await repo.read(legacyProject)).toEqual(state);
  expect((await readdir(f.privateRoot)).filter(n => n.endsWith("legacy-backup"))).toHaveLength(1);
});
test("private observations are opt-in, paragraph keystrokes coalesce and forgotten paragraphs stay excluded", async () => {
  const f = await fixture(); await f.create();
  const obs = { filename: "paper", blockId: "p1", before: "The original sentence.", after: "The revised sentence." };
  await f.run("observe", obs); expect(f.view.evidence).toHaveLength(0);
  await f.run("configure", { ...f.view.config, observe: true });
  await f.run("observe", obs); await f.run("observe", { ...obs, before: obs.after, after: "A precise sentence." });
  expect(f.view.evidence).toHaveLength(1); expect(f.view.evidence[0]?.observation?.before).toBe(obs.before);
  await f.run("forgetEvidence", { id: f.view.evidence[0]!.id }); await f.run("observe", obs); expect(f.view.evidence).toHaveLength(0);
});
test("sample exclusions strip protected and third-party blocks, comparison does not mutate manuscripts", async () => {
  expect(sampleProse("Own prose\n> Quoted text\n```js\ncode\n```\nReferences\nOther author")).toBe("Own prose");
  const f = await fixture(); await f.create(); await f.explicit(); f.respond("Result was different.");
  const result = await f.run("compare", { text: "The result was 12 in [@smith2026]." });
  expect("warnings" in result && result.warnings.length).toBeGreaterThan(0); expect(await readdir(f.path)).toEqual([]);
});

test("skip-next is consumed by one writing request, not by analysis, without invalidating editor revisions", async () => {
  const f = await fixture(); await f.create(); await f.explicit();
  await f.run("configure", { ...f.view.config, skipNext: true });
  expect((await f.service.context(f.path, { purpose: "extract" })).text).toBe("");
  const results = await Promise.all([1, 2].map(() => f.service.context(f.path, { purpose: "rewrite", language: "en" })));
  expect(results.filter(r => !!r.text)).toHaveLength(1);
  const state = await f.repo.read(f.path); expect(state.config.skipNext).toBeFalse(); expect(state.revision).toBe(f.view.revision);
});

test("cancelled and stale analyses cannot overwrite newer user rules", async () => {
  const f = await fixture(); await f.create(); await f.explicit();
  await f.run("addSample", { text: "This original authored passage is a useful demonstration of cautious scientific explanation.", label: "sample", ownWriting: true });
  let release!: (raw: string) => void, started!: () => void;
  const began = new Promise<void>(r => { started = r; });
  const service = new AuthorStyleService(f.repo, { info: async () => ({ local: true, label: "fixture" }), complete: () => { started(); return new Promise(r => { release = r; }); } });
  const controller = new AbortController();
  const work = service.analyze(f.path, f.view.activeProfileId!, f.view.revision, controller.signal); await began;
  controller.abort(); release('{"preferences":[],"sampleRules":[]}');
  await expect(work).rejects.toThrow();
  expect((await f.repo.read(f.path)).profiles[0]?.rules[0]?.instruction).toBe("Prefer precise verbs.");
});
