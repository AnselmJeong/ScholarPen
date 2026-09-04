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

  test("does not overwrite a malformed bibliography during validated append", async () => {
    const projectPath = await createTemporaryProject("scholarpen-bib-invalid-append-");
    await fileSystem.openProjectByPath(projectPath);
    const referencesPath = join(projectPath, "exports", "references.bib");
    const malformed = "@article{broken, title={Unclosed entry}";
    const combined = `${malformed}\n\n@article{newEntry, title={New entry}}`;
    await fileSystem.saveBibtexRaw(projectPath, malformed);

    await expect(
      fileSystem.saveBibtexValidated(projectPath, combined, malformed),
    ).rejects.toThrow("BibTeX parse error at line 1, column 1");
    expect(await readFile(referencesPath, "utf-8")).toBe(malformed);
  });

  test("saves a valid bibliography only when the editor baseline is current", async () => {
    const projectPath = await createTemporaryProject("scholarpen-bib-validated-save-");
    await fileSystem.openProjectByPath(projectPath);
    const original = "@article{original, title={Original}}";
    const external = "@article{external, title={External change}}";
    const proposed = `${original}\n\n@article{newEntry, title={New entry}}`;
    await fileSystem.saveBibtexRaw(projectPath, original);
    await fileSystem.saveBibtexRaw(projectPath, external);

    await expect(
      fileSystem.saveBibtexValidated(projectPath, proposed, original),
    ).rejects.toThrow("changed outside this editor");
    expect(await fileSystem.loadBibtex(projectPath)).toBe(external);
  });

  test("appends a new entry to the latest bibliography even when an open editor is stale", async () => {
    const projectPath = await createTemporaryProject("scholarpen-bib-stale-append-");
    await fileSystem.openProjectByPath(projectPath);
    const staleEditor = "@article{original, title={Original}}";
    const external = "@article{external, title={Added outside ScholarPen}}";
    const addition = "@article{newEntry, title={New entry}}";
    await fileSystem.saveBibtexRaw(projectPath, staleEditor);
    await fileSystem.saveBibtexRaw(projectPath, external);

    const result = await fileSystem.mergeBibtex(projectPath, addition);

    expect(result.addedEntries).toBe(1);
    expect(result.bibtex).toContain("@article{external");
    expect(result.bibtex).toContain("@article{newEntry");
    expect(result.bibtex).not.toContain("@article{original");
    expect(await fileSystem.loadBibtex(projectPath)).toBe(result.bibtex);
  });

  test("merges a BibTeX file while skipping only duplicate entries", async () => {
    const projectPath = await createTemporaryProject("scholarpen-bib-import-");
    await fileSystem.openProjectByPath(projectPath);
    const current = `@article{existing,
  author={Ada Author},
  title={Existing paper},
  year={2024},
  doi={10.1000/existing}
}`;
    await fileSystem.saveBibtexRaw(projectPath, current);

    const result = await fileSystem.mergeBibtex(projectPath, `@article{duplicateByDoi,
  author={Different Formatting},
  title={Existing paper copy},
  year={2024},
  doi={https://doi.org/10.1000/existing}
}

@article{newEntry,
  author={New Author},
  title={New paper},
  year={2025}
}

@article{newEntry,
  author={New Author},
  title={Repeated inside import},
  year={2025}
}`);

    expect(result.addedEntries).toBe(1);
    expect(result.skippedDuplicates).toEqual([
      { citekey: "duplicateByDoi", duplicateOfCitekey: "existing" },
      { citekey: "newEntry", duplicateOfCitekey: "newEntry" },
    ]);
    expect(result.bibtex).toContain("@article{existing");
    expect(result.bibtex).toContain("@article{newEntry");
    expect(result.bibtex).not.toContain("@article{duplicateByDoi");
    expect((result.bibtex.match(/@article\{newEntry/g) ?? [])).toHaveLength(1);
    expect(await fileSystem.loadBibtex(projectPath)).toBe(result.bibtex);
    expect(result.backupPath).not.toBeNull();
  });

  test("does not change the bibliography when every imported entry is a duplicate", async () => {
    const projectPath = await createTemporaryProject("scholarpen-bib-import-duplicates-");
    await fileSystem.openProjectByPath(projectPath);
    const current = "@article{existing, title={Existing paper}, year={2024}}";
    await fileSystem.saveBibtexRaw(projectPath, current);

    const result = await fileSystem.mergeBibtex(
      projectPath,
      "@article{existing, title={Replacement must not win}, year={2025}}",
    );

    expect(result.addedEntries).toBe(0);
    expect(result.skippedDuplicates).toEqual([
      { citekey: "existing", duplicateOfCitekey: "existing" },
    ]);
    expect(result.backupPath).toBeNull();
    expect(await fileSystem.loadBibtex(projectPath)).toBe(current);
  });

  test("rejects a malformed imported BibTeX file without changing the bibliography", async () => {
    const projectPath = await createTemporaryProject("scholarpen-bib-import-invalid-");
    await fileSystem.openProjectByPath(projectPath);
    const current = "@article{existing, title={Existing paper}}";
    await fileSystem.saveBibtexRaw(projectPath, current);

    await expect(
      fileSystem.mergeBibtex(projectPath, "@article{broken, title={Missing brace}"),
    ).rejects.toThrow("New BibTeX is invalid");
    expect(await fileSystem.loadBibtex(projectPath)).toBe(current);
  });

  test("does not let duplicate cleanup overwrite an externally changed bibliography", async () => {
    const projectPath = await createTemporaryProject("scholarpen-bib-stale-dedup-");
    await fileSystem.openProjectByPath(projectPath);
    const staleEditor = `@article{first, title={Same}, author={Author}, year={2024}}

@article{duplicate, title={Same}, author={Author}, year={2024}}`;
    const external = "@article{external, title={Added outside ScholarPen}, year={2025}}";
    await fileSystem.saveBibtexRaw(projectPath, staleEditor);
    await fileSystem.saveBibtexRaw(projectPath, external);

    await expect(
      fileSystem.deduplicateBibliography(projectPath, staleEditor),
    ).rejects.toThrow("changed outside this editor");
    expect(await fileSystem.loadBibtex(projectPath)).toBe(external);
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
