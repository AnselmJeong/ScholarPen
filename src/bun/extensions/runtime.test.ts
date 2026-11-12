import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bootstrap = `
import { initializeExtensions } from "./src/bun/extensions/runtime";
import { fileSystem } from "./src/bun/fs/manager";
import { createExtensionServices } from "./src/bun/extensions/services";
const host = await initializeExtensions(createExtensionServices({ fileSystem,
  recentlySavedFiles: new Set(), internallyUpdatingProjects: new Set(),
  sendProjectUpdated() {}, sendBibliographyValidationProgress() {}, buildSubprocessEnv: () => ({}) }));
const invoke = (operation, args) => host.invoke({ protocolVersion: 1, requestId: crypto.randomUUID(), operation, args });
`;
async function child(home: string, source: string) {
  const process = Bun.spawn([globalThis.process.execPath, "-e", bootstrap + source], {
    cwd: join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe",
    env: { ...globalThis.process.env, SCHOLARPEN_HOME: home, SCHOLARPEN_PROFILE_HOME: join(home, "profiles"), SCHOLARPEN_HINDSIGHT_DISABLED: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code !== 0) throw new Error(stderr);
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

test("real adapters preserve canonical bibliography and manuscripts with all six plugins disabled, and persist across restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "scholarpen-extensions-"));
  try {
    const result = await child(home, `
const project = await fileSystem.createProject("Fixture");
const bibtex = "@article{example, title={Preserved}, author={Author, A}, year={2026}}";
await invoke("scholarpen.bibliography.saveBibtexRaw", { projectPath: project.path, bibtex });
const blocks = [{ id: "p1", type: "paragraph", props: {}, content: [
  { type: "text", text: "한국어 é 👨‍👩‍👧‍👦 ", styles: {} },
  { type: "citation", props: { citekey: "example", locator: "" } }
], children: [] }];
const counts = await invoke("scholarpen.document-stats.count", { text: "one two" });
for (const info of host.list()) await host.setEnabled(info.manifest.id, false);
await fileSystem.saveDocument(project.path, "fixture.scholarpen.json", blocks);
const loaded = await fileSystem.loadDocument(project.path, "fixture.scholarpen.json");
let denied = false; try { await fileSystem.saveBibtexRaw(project.path, "overwrite"); } catch { denied = true; }
const saved = await fileSystem.loadBibtex(project.path);
await host.setEnabled("scholarpen.bibliography", true);
const reopened = await invoke("scholarpen.bibliography.loadBibtex", { projectPath: project.path });
console.log(JSON.stringify({ counts, denied, sameDocument: JSON.stringify(loaded) === JSON.stringify(blocks), sameBib: saved === bibtex && reopened === bibtex, disabled: host.list().filter(i => !i.enabled).length }));
`);
    expect(result).toMatchObject({ counts: { words: 2 }, denied: true, sameDocument: true, sameBib: true, disabled: 5 });
    const restarted = await child(home, 'console.log(JSON.stringify(host.list().map(info => ({ id: info.manifest.id, enabled: info.enabled, state: info.state }))));');
    expect(restarted.filter((info: { enabled: boolean }) => !info.enabled)).toHaveLength(5);
    expect(restarted.find((info: { id: string }) => info.id === "scholarpen.bibliography")).toMatchObject({ enabled: true, state: "inactive" });
    expect(JSON.parse(await readFile(join(home, "extensions.json"), "utf8")).version).toBe(1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("corrupt preferences fail closed without preventing the document shell from starting", async () => {
  const home = await mkdtemp(join(tmpdir(), "scholarpen-extension-corrupt-"));
  try {
    await Bun.write(join(home, "extensions.json"), "{broken");
    const result = await child(home, 'console.log(JSON.stringify(host.list().map(info => info.enabled)));');
    expect(result).toEqual([false, false, false, false, false, false]);
    expect(await readFile(join(home, "extensions.json"), "utf8")).toBe("{broken");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("personal profile gateway works without a project and explicit punctuation preferences survive plugin disable and restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "scholarpen-global-style-"));
  try {
    const result = await child(home, `
import { writingPreferences } from "./src/bun/ai/writing-preferences";
import { styleContext } from "./src/bun/ai/context-composer";
const library = await invoke("scholarpen.author-style.profile", { scope: "personal", projectPath: "", operation: "create", expectedRevision: 0, payload: { name: "Personal", language: "en", genre: "academic" } });
await writingPreferences.save(0, { emDash: "allow", semicolon: "allow" });
await host.setEnabled("scholarpen.author-style", false);
const context = await styleContext(undefined, { purpose: "rewrite", language: "en" });
console.log(JSON.stringify({ count: library.profiles.length, policy: context.text, enabled: host.isEnabled("scholarpen.author-style") }));
`);
    expect(result.count).toBe(1); expect(result.enabled).toBeFalse(); expect(result.policy).toContain('emDash="allow" semicolon="allow"'); expect(result.policy).not.toContain("<scholarpen_style ");
    const restarted = await child(home, `
import { writingPreferences } from "./src/bun/ai/writing-preferences";
await host.setEnabled("scholarpen.author-style", true);
console.log(JSON.stringify({ library: await invoke("scholarpen.author-style.profile", { scope: "personal", projectPath: "", operation: "view" }), preferences: await writingPreferences.read() }));
`);
    expect(restarted.library.profiles[0].name).toBe("Personal"); expect(restarted.preferences.punctuation).toEqual({ emDash: "allow", semicolon: "allow" });
  } finally { await rm(home, { recursive: true, force: true }); }
});
