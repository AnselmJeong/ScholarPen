import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
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

async function createTemporaryProject(prefix: string): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), prefix));
  temporaryProjects.push(projectPath);
  await mkdir(join(projectPath, "documents"), { recursive: true });
  return projectPath;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("bibliography storage", () => {
  test("moves a legacy root bibliography into exports when opening a project", async () => {
    const projectPath = await createTemporaryProject("scholarpen-bib-move-");
    const legacyPath = join(projectPath, "references.bib");
    const referencesPath = join(projectPath, "exports", "references.bib");
    const bibtex = "@article{legacy, title={Legacy reference}}";
    await writeFile(legacyPath, bibtex);

    const project = await fileSystem.openProjectByPath(projectPath);

    expect(await readFile(referencesPath, "utf-8")).toBe(bibtex);
    expect(await pathExists(legacyPath)).toBe(false);
    expect(project.files.find((file) => file.type === "reference")?.path)
      .toBe(referencesPath);
  });

  test("merges distinct files and backs up the legacy root bibliography", async () => {
    const projectPath = await createTemporaryProject("scholarpen-bib-merge-");
    const exportsPath = join(projectPath, "exports");
    const legacyPath = join(projectPath, "references.bib");
    const referencesPath = join(exportsPath, "references.bib");
    await mkdir(exportsPath, { recursive: true });
    await writeFile(
      referencesPath,
      "@article{current, title={Current reference}}\n\n"
        + "@article{shared, title={Current version}}",
    );
    await writeFile(
      legacyPath,
      "@article{legacy, title={Legacy reference}}\n\n"
        + "@article{shared, title={Legacy version}}",
    );

    await fileSystem.openProjectByPath(projectPath);

    const merged = await readFile(referencesPath, "utf-8");
    expect(merged).toContain("@article{current");
    expect(merged).toContain("@article{legacy");
    expect(merged).toContain("title={Current version}");
    expect(merged).not.toContain("title={Legacy version}");
    expect(await pathExists(legacyPath)).toBe(false);

    const backupsPath = join(projectPath, ".scholarpen", "backups");
    const backups = await readdir(backupsPath);
    expect(backups).toHaveLength(1);
    expect(await readFile(join(backupsPath, backups[0]), "utf-8"))
      .toContain("title={Legacy version}");
  });

  test("loads and saves only the bibliography in exports", async () => {
    const projectPath = await createTemporaryProject("scholarpen-bib-save-");
    await fileSystem.openProjectByPath(projectPath);
    const referencesPath = join(projectPath, "exports", "references.bib");
    const bibtex = "@book{canonical, title={Canonical bibliography}}";

    await fileSystem.saveBibtexRaw(projectPath, bibtex);

    expect(await fileSystem.loadBibtex(projectPath)).toBe(bibtex);
    expect(await readFile(referencesPath, "utf-8")).toBe(bibtex);
    expect(await pathExists(join(projectPath, "references.bib"))).toBe(false);
  });

  test("deduplicates by identity and remaps citations across documents", async () => {
    const projectPath = await createTemporaryProject("scholarpen-bib-dedup-");
    await fileSystem.openProjectByPath(projectPath);
    const referencesPath = join(projectPath, "exports", "references.bib");
    const documentPath = join(projectPath, "documents", "section.scholarpen.json");
    const bibtex = `@article{friston2010freeenergy,
  author={Karl Friston},
  title={The free-energy principle: a unified brain theory?},
  year={2010}
}

@article{friston2010the,
  author={Karl Friston},
  title={The free-energy principle: a unified brain theory?},
  year={2010}
}`;
    const document = [{
      type: "paragraph",
      content: [
        { type: "citation", props: { citekey: "friston2010the", locator: "p. 3" } },
        { type: "citation", props: { citekey: "friston2010freeenergy", locator: "" } },
      ],
    }];
    await writeFile(referencesPath, bibtex);
    await writeFile(documentPath, JSON.stringify(document));

    const result = await fileSystem.deduplicateBibliography(projectPath, bibtex);

    expect(result.removedEntries).toBe(1);
    expect(result.updatedDocuments).toBe(1);
    expect(result.remappedCitations).toBe(1);
    expect(result.citekeyRemap).toEqual({
      friston2010the: "friston2010freeenergy",
    });
    expect(await readFile(referencesPath, "utf-8"))
      .not.toContain("@article{friston2010the");
    const updatedDocument = JSON.parse(await readFile(documentPath, "utf-8"));
    expect(updatedDocument[0].content.map(
      (citation: { props: { citekey: string } }) => citation.props.citekey,
    )).toEqual(["friston2010freeenergy", "friston2010freeenergy"]);

    expect(result.backupPath).not.toBeNull();
    expect(await readFile(
      join(result.backupPath!, "exports", "references.bib"),
      "utf-8",
    )).toBe(bibtex);
    expect(JSON.parse(await readFile(
      join(result.backupPath!, "documents", "section.scholarpen.json"),
      "utf-8",
    ))).toEqual(document);
  });
});
