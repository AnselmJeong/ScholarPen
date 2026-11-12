import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { buildBibtexDeduplicationPlan, buildBibtexAppendPlan, collectDocumentCitationKeys, deduplicateBibtex, parseBibtexEntries, partitionBibtexAdditions, remapDocumentCitationKeys } from "../../../shared/bibtex-utils";
import type { BibliographyDeduplicationResult, BibliographyMergeResult } from "../../../shared/rpc-types";
import { BIBLIOGRAPHY_RELATIVE_PATH } from "../../../shared/bibliography-path";
export interface BibliographyStorage {
  resolveProjectPath(path: string): Promise<string>;
  writeFileAtomically(path: string, content: string | Uint8Array): Promise<void>;
}
/** Canonical repository. Storage authorization and atomic primitives belong to the host. */
export class BibliographyRepository {
  constructor(private storage: BibliographyStorage) {}
  private assertValidBibtex(bibtex: string): void {
    const issue = parseBibtexEntries(bibtex).issues[0];
    if (issue) {
      throw new Error(
        `BibTeX parse error at line ${issue.line}, column ${issue.column}: ${issue.message}`,
      );
    }
  }

  async saveBibtex(projectPath: string, bibtex: string): Promise<void> {
    projectPath = await this.storage.resolveProjectPath(projectPath);
    const referencesPath = join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH);
    this.assertValidBibtex(bibtex);
    await this.storage.writeFileAtomically(referencesPath, deduplicateBibtex(bibtex));
  }

  async saveBibtexRaw(projectPath: string, bibtex: string): Promise<void> {
    projectPath = await this.storage.resolveProjectPath(projectPath);
    const referencesPath = join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH);
    await this.storage.writeFileAtomically(referencesPath, bibtex);
  }

  async saveBibtexValidated(
    projectPath: string,
    bibtex: string,
    expectedCurrentBibtex: string,
  ): Promise<void> {
    projectPath = await this.storage.resolveProjectPath(projectPath);
    this.assertValidBibtex(bibtex);
    const referencesPath = join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH);
    let current = "";
    try {
      current = await readFile(referencesPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current !== expectedCurrentBibtex) {
      throw new Error(
        "references.bib changed outside this editor. Reload it before saving to avoid overwriting newer changes.",
      );
    }
    await this.storage.writeFileAtomically(referencesPath, bibtex);
  }

  async loadBibtex(projectPath: string): Promise<string> {
    projectPath = await this.storage.resolveProjectPath(projectPath);
    try {
      return await readFile(join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  async mergeBibtex(
    projectPath: string,
    importedBibtex: string,
  ): Promise<BibliographyMergeResult> {
    projectPath = await this.storage.resolveProjectPath(projectPath);
    const currentBibtex = await this.loadBibtex(projectPath);
    const appendPlan = buildBibtexAppendPlan(currentBibtex, importedBibtex);
    const currentEntries = parseBibtexEntries(currentBibtex).entries;
    const { accepted, skipped } = partitionBibtexAdditions(
      currentEntries,
      appendPlan.addedEntries,
    );

    if (accepted.length === 0) {
      return {
        bibtex: currentBibtex,
        addedEntries: 0,
        skippedDuplicates: skipped.map(({ entry, duplicateOf }) => ({
          citekey: entry.citekey,
          duplicateOfCitekey: duplicateOf.citekey,
        })),
        backupPath: null,
      };
    }

    const merged = buildBibtexAppendPlan(
      currentBibtex,
      accepted.map((entry) => entry.raw).join("\n\n"),
    ).bibtex;
    const backupPath = await this.saveBibliographyMaintenance(
      projectPath,
      merged,
      "bibliography-import",
      currentBibtex,
    );

    return {
      bibtex: merged,
      addedEntries: accepted.length,
      skippedDuplicates: skipped.map(({ entry, duplicateOf }) => ({
        citekey: entry.citekey,
        duplicateOfCitekey: duplicateOf.citekey,
      })),
      backupPath,
    };
  }

  async scanBibliographyUsage(projectPath: string): Promise<{
    usedCitekeys: string[];
    scannedDocuments: number;
  }> {
    projectPath = await this.storage.resolveProjectPath(projectPath);
    const documentsDir = join(projectPath, "documents");
    const documentPaths: string[] = [];
    const collect = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory()) await collect(entryPath);
        else if (entry.name.endsWith(".scholarpen.json")) documentPaths.push(entryPath);
      }
    };
    try {
      await collect(documentsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const usedCitekeys = new Set<string>();
    for (const filePath of documentPaths) {
      try {
        const content = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
        collectDocumentCitationKeys(content, usedCitekeys);
      } catch (error) {
        throw new Error(
          `인용 스캔 실패: ${relative(projectPath, filePath)} (${error instanceof Error ? error.message : "invalid document"})`,
        );
      }
    }
    return { usedCitekeys: Array.from(usedCitekeys), scannedDocuments: documentPaths.length };
  }

  async saveBibliographyMaintenance(
    projectPath: string,
    bibtex: string,
    backupPrefix: string,
    expectedOriginal?: string,
  ): Promise<string | null> {
    projectPath = await this.storage.resolveProjectPath(projectPath);
    this.assertValidBibtex(bibtex);
    const referencesPath = join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH);
    let original = "";
    try {
      original = await readFile(referencesPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (expectedOriginal !== undefined && original !== expectedOriginal) {
      throw new Error(
        "references.bib changed outside ScholarPen. Reload it before applying this operation to avoid overwriting newer changes.",
      );
    }
    if (original === bibtex) return null;

    const backupStamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(
      projectPath,
      ".scholarpen",
      "backups",
      `${backupPrefix}-${backupStamp}`,
    );
    const bibliographyBackupPath = join(backupPath, BIBLIOGRAPHY_RELATIVE_PATH);
    await mkdir(dirname(bibliographyBackupPath), { recursive: true });
    await writeFile(bibliographyBackupPath, original, "utf-8");
    try {
      await this.storage.writeFileAtomically(referencesPath, bibtex);
    } catch (error) {
      await writeFile(referencesPath, original, "utf-8");
      throw error;
    }
    return backupPath;
  }

  async deduplicateBibliography(
    projectPath: string,
    bibtex: string,
  ): Promise<BibliographyDeduplicationResult> {
    projectPath = await this.storage.resolveProjectPath(projectPath);
    this.assertValidBibtex(bibtex);
    const plan = buildBibtexDeduplicationPlan(bibtex);
    if (plan.removedEntries === 0) {
      return {
        bibtex,
        removedEntries: 0,
        remappedCitations: 0,
        updatedDocuments: 0,
        citekeyRemap: {},
        backupPath: null,
      };
    }

    const referencesPath = join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH);
    const documentsDir = join(projectPath, "documents");
    const documentPaths: string[] = [];
    const collectDocumentPaths = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          await collectDocumentPaths(entryPath);
        } else if (entry.name.endsWith(".scholarpen.json")) {
          documentPaths.push(entryPath);
        }
      }
    };
    try {
      await collectDocumentPaths(documentsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const updatedDocuments: Array<{
      filePath: string;
      original: string;
      updated: string;
      replacementCount: number;
    }> = [];
    for (const filePath of documentPaths) {
      const original = await readFile(filePath, "utf-8");
      const content = JSON.parse(original) as unknown;
      const remapped = remapDocumentCitationKeys(content, plan.citekeyRemap);
      if (remapped.replacementCount === 0) continue;
      updatedDocuments.push({
        filePath,
        original,
        updated: JSON.stringify(remapped.content, null, 2),
        replacementCount: remapped.replacementCount,
      });
    }

    let originalBibtex = "";
    try {
      originalBibtex = await readFile(referencesPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (originalBibtex !== bibtex) {
      throw new Error(
        "references.bib changed outside this editor. Reload it before deduplicating to avoid overwriting newer changes.",
      );
    }

    const backupStamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(
      projectPath,
      ".scholarpen",
      "backups",
      `bibliography-dedup-${backupStamp}`,
    );
    const bibliographyBackupPath = join(backupPath, BIBLIOGRAPHY_RELATIVE_PATH);
    await mkdir(dirname(bibliographyBackupPath), { recursive: true });
    await writeFile(bibliographyBackupPath, originalBibtex, "utf-8");
    for (const document of updatedDocuments) {
      const documentBackupPath = join(backupPath, relative(projectPath, document.filePath));
      await mkdir(dirname(documentBackupPath), { recursive: true });
      await writeFile(documentBackupPath, document.original, "utf-8");
    }

    try {
      for (const document of updatedDocuments) {
        await writeFile(document.filePath, document.updated, "utf-8");
      }
      await writeFile(referencesPath, plan.bibtex, "utf-8");
    } catch (error) {
      await Promise.allSettled([
        writeFile(referencesPath, originalBibtex, "utf-8"),
        ...updatedDocuments.map((document) =>
          writeFile(document.filePath, document.original, "utf-8")
        ),
      ]);
      throw error;
    }

    return {
      bibtex: plan.bibtex,
      removedEntries: plan.removedEntries,
      remappedCitations: updatedDocuments.reduce(
        (count, document) => count + document.replacementCount,
        0,
      ),
      updatedDocuments: updatedDocuments.length,
      citekeyRemap: plan.citekeyRemap,
      backupPath,
    };
  }

}
