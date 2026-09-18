import { readdir, realpath, stat } from "fs/promises";
import { join } from "path";
import { documentReferenceTargets, type ReferenceDocument } from "../../shared/project-references";

/** Metadata-only RPC output; unchanged chapters do not need JSON parsing again. */
export class ProjectReferenceIndex {
  private project = "";
  private cache = new Map<string, { signature: string; document: ReferenceDocument }>();

  async read(projectPath: string, load: (filename: string) => Promise<unknown>): Promise<ReferenceDocument[]> {
    if (this.project !== projectPath) { this.project = projectPath; this.cache = new Map(); }
    const cache = this.cache;
    const root = join(projectPath, "documents");
    if (await realpath(root) !== join(await realpath(projectPath), "documents")) throw new Error("Invalid documents directory");
    const files: string[] = [];
    async function walk(directory: string, prefix = "") {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const filename = prefix + entry.name;
        if (entry.isDirectory()) await walk(join(directory, entry.name), filename + "/");
        else if (entry.isFile() && entry.name.endsWith(".scholarpen.json")) files.push(filename);
      }
    }
    await walk(root);
    const current = new Set(files);
    for (const filename of cache.keys()) if (!current.has(filename)) cache.delete(filename);
    const documents: ReferenceDocument[] = [];
    for (const filename of files.sort()) {
      try {
        const info = await stat(join(root, filename));
        const signature = `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}`;
        let cached = cache.get(filename);
        if (cached?.signature !== signature) {
          cached = { signature, document: { filename, targets: documentReferenceTargets(await load(filename)) } };
          cache.set(filename, cached);
        }
        documents.push(cached.document);
      } catch (error) {
        cache.delete(filename);
        documents.push({ filename, targets: [], error: error instanceof Error ? error.message : String(error) });
      }
    }
    return documents;
  }
}
