import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";
import type { CollabMeta, CollabStorage } from "./registry";

export interface CollabPathResolver {
  collabStatePath(projectPath: string, filename: string): Promise<string>;
  documentJsonHash(projectPath: string, filename: string): Promise<string | null>;
}

async function readOptional(path: string) {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(path: string, data: Uint8Array | string) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data);
  await rename(temp, path);
}

/** Stores `<project>/.scholarpen/collab/<document>.ydoc` plus a small meta file beside it. */
export function createFileCollabStorage(resolver: CollabPathResolver): CollabStorage {
  return {
    async read(projectPath, filename) {
      const path = await resolver.collabStatePath(projectPath, filename);
      const [state, meta] = await Promise.all([readOptional(path), readOptional(`${path}.meta.json`)]);
      let parsed: CollabMeta | null = null;
      if (meta) {
        try { parsed = JSON.parse(meta.toString("utf8")) as CollabMeta; }
        catch { parsed = null; }
      }
      return { state: state ? new Uint8Array(state) : null, meta: parsed };
    },
    async write(projectPath, filename, state, meta) {
      const path = await resolver.collabStatePath(projectPath, filename);
      await writeAtomic(path, state);
      await writeAtomic(`${path}.meta.json`, JSON.stringify(meta));
    },
    jsonHash: (projectPath, filename) => resolver.documentJsonHash(projectPath, filename),
  };
}
