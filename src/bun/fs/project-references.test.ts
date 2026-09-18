import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ProjectReferenceIndex } from "./project-references";
import { fileSystem } from "./manager";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function project() {
  const path = await mkdtemp(join(tmpdir(), "scholarpen-project-refs-"));
  temporary.push(path);
  await mkdir(join(path, "documents"));
  return path;
}
async function write(path: string, filename: string, label: string) {
  const full = join(path, "documents", filename);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, JSON.stringify([{ id: label, type: "figure", props: { label, caption: "Caption" } }]));
}

test("indexes every nested chapter through the main-process entry point, excluding exports and symlinks", async () => {
  const path = await project();
  await write(path, "a.scholarpen.json", "fig-a");
  await write(path, "one/two/three/four/five/six/a.scholarpen.json", "fig-deep");
  await mkdir(join(path, "exports"));
  await writeFile(join(path, "exports", "copy.scholarpen.json"), '[{"type":"figure","props":{"label":"fig-copy"}}]');
  await symlink(join(path, "exports"), join(path, "documents", "linked"));
  await fileSystem.openProjectByPath(path);
  const result = await fileSystem.listProjectReferences(path);
  expect(result.flatMap((document) => document.targets.map((target) => target.label))).toEqual(["fig-a", "fig-deep"]);
  expect(result[1].filename).toBe("one/two/three/four/five/six/a.scholarpen.json");
});

test("refreshes changed, renamed, deleted and added files, and reuses unchanged targets", async () => {
  const path = await project();
  const index = new ProjectReferenceIndex();
  let reads = 0;
  const load = async (filename: string) => { reads++; return JSON.parse(await readFile(join(path, "documents", filename), "utf8")); };
  await write(path, "a.scholarpen.json", "fig-old");
  await index.read(path, load);
  await index.read(path, load);
  expect(reads).toBe(1);
  await write(path, "a.scholarpen.json", "fig-edited-longer");
  expect((await index.read(path, load))[0].targets[0].label).toBe("fig-edited-longer");
  await rename(join(path, "documents", "a.scholarpen.json"), join(path, "documents", "b.scholarpen.json"));
  expect((await index.read(path, load)).map((document) => document.filename)).toEqual(["b.scholarpen.json"]);
  await rm(join(path, "documents", "b.scholarpen.json"));
  expect(await index.read(path, load)).toEqual([]);
  await write(path, "c.scholarpen.json", "fig-new");
  expect((await index.read(path, load))[0].targets[0].label).toBe("fig-new");
});

test("keeps healthy chapters available when a file is corrupt, and recovers on repair", async () => {
  const path = await project();
  const index = new ProjectReferenceIndex();
  const load = async (filename: string) => JSON.parse(await readFile(join(path, "documents", filename), "utf8"));
  await write(path, "a.scholarpen.json", "fig-good");
  await writeFile(join(path, "documents", "b.scholarpen.json"), "broken JSON");
  const result = await index.read(path, load);
  expect(result[0].targets[0].label).toBe("fig-good");
  expect(result[1].error).toBeTruthy();
  await write(path, "b.scholarpen.json", "fig-repaired");
  expect((await index.read(path, load))[1].targets[0].label).toBe("fig-repaired");
});

test("does not reuse a namesake chapter from a different project", async () => {
  const a = await project();
  const b = await project();
  const index = new ProjectReferenceIndex();
  await write(a, "same.scholarpen.json", "fig-project-a");
  await write(b, "same.scholarpen.json", "fig-project-b");
  const read = (path: string) => index.read(path, async (filename) => JSON.parse(await readFile(join(path, "documents", filename), "utf8")));
  expect((await read(a))[0].targets[0].label).toBe("fig-project-a");
  expect((await read(b))[0].targets[0].label).toBe("fig-project-b");
  expect((await read(a))[0].targets[0].label).toBe("fig-project-a");
});
