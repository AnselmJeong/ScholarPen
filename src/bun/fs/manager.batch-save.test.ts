import { afterEach, describe, expect, test } from "bun:test";
import {
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
