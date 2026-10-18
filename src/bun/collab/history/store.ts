import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type { StoredEntry } from "./thinning";

export interface HistoryIndex {
  version: 1;
  nextSeq: number;
  /** State vector (base64) of the first checkpoint: a Y.Doc that has not seen it is another document. */
  baseSv: string;
  /** State vector (base64) the newest checkpoint ends at. */
  headSv: string;
  /** Oldest first. */
  entries: StoredEntry[];
}

export interface HistoryStorage {
  /** Null when the document has no history yet; throws when the index cannot be read. */
  readIndex(projectPath: string, filename: string): Promise<HistoryIndex | null>;
  writeIndex(projectPath: string, filename: string, index: HistoryIndex): Promise<void>;
  readChunk(projectPath: string, filename: string, seq: number): Promise<Uint8Array | null>;
  writeChunk(projectPath: string, filename: string, seq: number, data: Uint8Array): Promise<void>;
  deleteChunk(projectPath: string, filename: string, seq: number): Promise<void>;
  /** Moves a history that no longer matches the document out of the way. */
  archive(projectPath: string, filename: string): Promise<void>;
}

export interface HistoryPathResolver {
  /** `<project>/.scholarpen/history/<document>` */
  historyDir(projectPath: string, filename: string): Promise<string>;
}

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function writeAtomic(path: string, data: Uint8Array | string) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data);
  await rename(temp, path);
}

/**
 * One small file per checkpoint plus an index, so a synced project folder
 * uploads only what changed instead of one growing file.
 */
export function createFileHistoryStorage(resolver: HistoryPathResolver): HistoryStorage {
  const chunkPath = async (projectPath: string, filename: string, seq: number) =>
    join(await resolver.historyDir(projectPath, filename), "chunks", `${seq}.yupd`);
  return {
    async readIndex(projectPath, filename) {
      let text: string;
      try {
        text = await readFile(join(await resolver.historyDir(projectPath, filename), "index.json"), "utf8");
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
      const index = JSON.parse(text) as HistoryIndex;
      if (index.version !== 1 || !Array.isArray(index.entries)) throw new Error("Unknown history format");
      return index;
    },
    async writeIndex(projectPath, filename, index) {
      await writeAtomic(join(await resolver.historyDir(projectPath, filename), "index.json"), JSON.stringify(index));
    },
    async readChunk(projectPath, filename, seq) {
      try {
        return new Uint8Array(await readFile(await chunkPath(projectPath, filename, seq)));
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async writeChunk(projectPath, filename, seq, data) {
      await writeAtomic(await chunkPath(projectPath, filename, seq), data);
    },
    async deleteChunk(projectPath, filename, seq) {
      try {
        await unlink(await chunkPath(projectPath, filename, seq));
      } catch (error) {
        if (!missing(error)) throw error;
      }
    },
    async archive(projectPath, filename) {
      const dir = await resolver.historyDir(projectPath, filename);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      try {
        await rename(dir, `${dir}.orphaned-${stamp}`);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    },
  };
}
