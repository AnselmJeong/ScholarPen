import { afterEach, describe, expect, test } from "bun:test";
import {
  symlink,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { fileSystem } from "./manager";

const temporaryProjects: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("batch document save", () => {
  test("updates documents together and preserves recovery copies", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "scholarpen-batch-save-"));
    temporaryProjects.push(projectPath);
    const documentsPath = join(projectPath, "documents");
    await mkdir(documentsPath, { recursive: true });
    await writeFile(join(documentsPath, "01-a.scholarpen.json"), '["before-a"]');
    await writeFile(join(documentsPath, "02-b.scholarpen.json"), '["before-b"]');
    await fileSystem.openProjectByPath(projectPath);

    await fileSystem.saveDocuments(projectPath, [
      { filename: "01-a.scholarpen.json", content: ["after-a"] },
      { filename: "02-b.scholarpen.json", content: ["after-b"] },
    ]);

    expect(JSON.parse(await readFile(
      join(documentsPath, "01-a.scholarpen.json"),
      "utf-8",
    ))).toEqual(["after-a"]);
    expect(JSON.parse(await readFile(
      join(documentsPath, "02-b.scholarpen.json"),
      "utf-8",
    ))).toEqual(["after-b"]);

    const backupsRoot = join(projectPath, ".scholarpen", "backups");
    const backupDirectories = await readdir(backupsRoot);
    expect(backupDirectories).toHaveLength(1);
    const backupPath = join(backupsRoot, backupDirectories[0]);
    expect(await readFile(join(backupPath, "01-a.scholarpen.json"), "utf-8"))
      .toBe('["before-a"]');
    expect(await readFile(join(backupPath, "02-b.scholarpen.json"), "utf-8"))
      .toBe('["before-b"]');
  });
});


test("nested documents load, save, and back up by relative path without touching namesakes", async () => {
  const project = await mkdtemp(join(tmpdir(), "scholarpen-nested-find-"));
  temporaryProjects.push(project);
  await mkdir(join(project, "documents", "chapter"), { recursive: true });
  await writeFile(join(project, "documents", "a.scholarpen.json"), '["root"]');
  await writeFile(join(project, "documents", "chapter", "a.scholarpen.json"), '["nested"]');
  await fileSystem.openProjectByPath(project);
  expect(await fileSystem.loadDocument(project, "chapter/a.scholarpen.json")).toEqual(["nested"]);
  await fileSystem.saveDocument(project, "chapter/a.scholarpen.json", ["edited"]);
  await fileSystem.saveDocuments(project, [{ filename: "chapter/a.scholarpen.json", content: ["replaced"] }]);
  expect(await fileSystem.loadDocument(project, "chapter/a.scholarpen.json")).toEqual(["replaced"]);
  expect(await fileSystem.loadDocument(project, "a.scholarpen.json")).toEqual(["root"]);
  const backups = join(project, ".scholarpen", "backups");
  const [backup] = await readdir(backups);
  expect(JSON.parse(await readFile(join(backups, backup, "chapter", "a.scholarpen.json"), "utf8"))).toEqual(["edited"]);
  await expect(fileSystem.loadDocument(project, "../a.scholarpen.json")).rejects.toThrow();
  await expect(fileSystem.loadDocument(project, "/a.scholarpen.json")).rejects.toThrow();
  await mkdir(join(project, "drafts"));
  await writeFile(join(project, "drafts", "a.scholarpen.json"), '["outside"]');
  await symlink(join(project, "drafts"), join(project, "documents", "escape"));
  await expect(fileSystem.loadDocument(project, "escape/a.scholarpen.json")).rejects.toThrow();
  await expect(fileSystem.saveDocument(project, "escape/a.scholarpen.json", [])).rejects.toThrow();
});
