import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EMPTY_GLOSSARY, normalizeGlossary, type Glossary } from "../../shared/glossary";
import { EMPTY_MAP, normalizeMap, type ManuscriptMap } from "../../shared/manuscript-map";
import { normalizeConsistencyReport, type ConsistencyReport } from "../../shared/consistency-report";

const FILES = {
  glossary: "glossary.json",
  map: "manuscript-map.json",
  report: "consistency-report.json",
} as const;

type Kind = keyof typeof FILES;
type Value<K extends Kind> = K extends "glossary" ? Glossary : K extends "map" ? ManuscriptMap : ConsistencyReport | null;

/**
 * Project-wide writing data in `.scholarpen/`: the glossary, the manuscript
 * map and the last consistency report. Writes to one file are serialized, so
 * two editors (or the AI and an editor) never overwrite each other.
 */
export class ProjectWritingStore {
  private readonly pending = new Map<string, Promise<unknown>>();

  private async root(projectPath: string) {
    const root = await realpath(projectPath);
    if (!(await stat(root)).isDirectory()) throw new Error("The project folder is not a directory.");
    return root;
  }

  private async readFile<K extends Kind>(root: string, kind: K): Promise<Value<K>> {
    let source: string;
    try {
      source = await readFile(join(root, ".scholarpen", FILES[kind]), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return (kind === "glossary" ? EMPTY_GLOSSARY : kind === "map" ? EMPTY_MAP : null) as Value<K>;
    }
    const value: unknown = JSON.parse(source);
    return (kind === "glossary" ? normalizeGlossary(value) : kind === "map" ? normalizeMap(value) : normalizeConsistencyReport(value)) as Value<K>;
  }

  async read<K extends Kind>(projectPath: string, kind: K): Promise<Value<K>> {
    const root = await this.root(projectPath);
    await this.pending.get(`${root}:${kind}`)?.catch(() => undefined);
    return this.readFile(root, kind);
  }

  /** Read-modify-write under the file's lock. */
  async update<K extends Kind>(projectPath: string, kind: K, change: (current: Value<K>) => Value<K>): Promise<Value<K>> {
    const root = await this.root(projectPath);
    const key = `${root}:${kind}`;
    const previous = this.pending.get(key);
    const work = (async () => {
      await previous?.catch(() => undefined);
      const next = change(await this.readFile(root, kind));
      const dir = join(root, ".scholarpen");
      await mkdir(dir, { recursive: true });
      const path = join(dir, FILES[kind]);
      const temp = `${path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(next, null, 2) + "\n");
      await rename(temp, path);
      return next;
    })();
    this.pending.set(key, work);
    try {
      return await work;
    } finally {
      if (this.pending.get(key) === work) this.pending.delete(key);
    }
  }
}
