import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initializeProjectSkeleton } from "./manager";

const temporaryProjects: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryProjects.splice(0).map((projectPath) =>
      rm(projectPath, { recursive: true, force: true }),
    ),
  );
});

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

describe("new project skeleton", () => {
  test("creates resource and draft folders without the legacy Knowledge_Base", async () => {
    const parentPath = await mkdtemp(join(tmpdir(), "scholarpen-project-skeleton-"));
    temporaryProjects.push(parentPath);
    const projectName = "new-research-project";
    const projectPath = join(parentPath, projectName);

    await initializeProjectSkeleton(projectPath, projectName);

    expect((await readdir(projectPath)).sort()).toEqual([
      "documents",
      "drafts",
      "exports",
      "figures",
      "resources",
    ]);
    expect(await isDirectory(join(projectPath, "resources", "articles"))).toBe(true);
    expect(await isDirectory(join(projectPath, "resources", "books"))).toBe(true);
    expect(await isDirectory(join(projectPath, "Knowledge_Base"))).toBe(false);
    expect(
      await readFile(
        join(projectPath, "documents", `${projectName}.scholarpen.json`),
        "utf-8",
      ),
    ).toBe("[]");
    expect(
      await readFile(join(projectPath, "exports", "references.bib"), "utf-8"),
    ).toBe("");
  });
});
