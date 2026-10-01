import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { fileSystem } from "./manager";
let project: string;
afterEach(async () => { if (project) await rm(project, { recursive: true, force: true }); });
test("concurrent imports with the same name preserve the existing document and each import", async () => {
  project = await mkdtemp(join(tmpdir(), "scholarpen-import-"));
  await mkdir(join(project, "documents"));
  await fileSystem.openProjectByPath(project);
  const original = '[{"type":"paragraph","content":"original manuscript"}]';
  await writeFile(join(project, "documents", "chapter.scholarpen.json"), original);
  const names = await Promise.all([1, 2, 3].map(id => fileSystem.createDocument(project, "chapter.scholarpen.json", [{ id }])));
  expect(new Set(names).size).toBe(3);
  expect(await readFile(join(project, "documents", "chapter.scholarpen.json"), "utf8")).toBe(original);
  for (const [index, name] of names.entries()) {
    expect(JSON.parse(await readFile(join(project, "documents", name), "utf8"))).toEqual([{ id: index + 1 }]);
  }
});
