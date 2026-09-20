import { randomUUID } from "crypto";
import { lstat, readFile, realpath, writeFile } from "fs/promises";
import { basename, dirname, join, relative, resolve } from "path";
import { bundleExportImages, ensureExportDirectory, isInsideDirectory, writeExportAtomically,
  type ExportDocument } from "../fs/export-image-bundle";
import { quartoBookChapterFiles } from "./reference-validation";

/** ScholarPen books live in exports/. Standalone Quarto projects are untouched. */
export async function prepareQuartoBookImages(directory: string, config: string): Promise<void> {
  if (basename(directory) !== "exports") return;
  const project = await realpath(dirname(directory));
  const exports = join(project, "exports");
  await ensureExportDirectory(project, exports);
  const documents: ExportDocument[] = [];
  for (const filename of quartoBookChapterFiles(config)) {
    const path = resolve(exports, filename);
    if (!isInsideDirectory(exports, path)) throw new Error(`The book chapter is outside exports/: ${filename}`);
    try {
      if (!(await lstat(path)).isFile() || await realpath(path) !== path) {
        throw new Error(`The book chapter must not be a symlink: ${filename}`);
      }
      documents.push({ path, content: await readFile(path, "utf8") });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // Quarto reports missing chapters.
      throw error;
    }
  }
  const prepared = await bundleExportImages(project, documents);
  const changed = prepared.filter((document, index) => document.content !== documents[index].content);
  if (!changed.length) return;
  const originals = new Map(documents.map((document) => [document.path, document.content]));
  const backup = join(project, ".scholarpen", "backups", `export-images-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  // Save every original before changing the first existing chapter.
  for (const document of changed) {
    if (await readFile(document.path, "utf8") !== originals.get(document.path)) {
      throw new Error(`The chapter changed while preparing figures: ${basename(document.path)}. Render again.`);
    }
    const file = join(backup, "exports", relative(exports, document.path));
    await ensureExportDirectory(project, dirname(file));
    await writeFile(file, originals.get(document.path)!, { flag: "wx" });
  }
  for (const document of changed) {
    if (await readFile(document.path, "utf8") !== originals.get(document.path)) {
      throw new Error(`The chapter changed while preparing figures: ${basename(document.path)}. Render again.`);
    }
    await writeExportAtomically(project, document.path, document.content);
  }
}
