import { createHash, randomUUID } from "crypto";
import { mkdir, readFile, rename, writeFile, stat } from "fs/promises";
import { join } from "path";
import type { ProjectMemoryService } from "./hindsight";
import { collectMemorySources } from "./sources";
import type { AuthorLearning } from "./learning";

interface SyncedSource { hash: string; operationId: string; state: "processing" | "completed" | "failed" }
interface SyncState { version: 1; bankId: string; sources: Record<string, SyncedSource> }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const sourceDocumentId = (key: string) => `scholarpen-auto-${hash(key)}`;

/** A durable acknowledgement ledger: pending operations survive relaunch, and edits replace the same source. */
export class ProjectMemorySync {
  private running = new Map<string, Promise<void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private generation = 0;
  private errors = new Map<string, string>();
  constructor(private client: ProjectMemoryService, private learning?: AuthorLearning) {}

  error(path: string) { return this.errors.get(path); }

  start(path: string) {
    if (this.timers.has(path)) return;
    // Only the open project is watched. Other projects resume their durable queue when reopened.
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const generation = ++this.generation;
    const tick = () => {
      void this.sync(path).catch(error => console.warn("[Hindsight] Auto-sync:", String(error))).finally(() => {
        if (generation !== this.generation) return;
        const timer = setTimeout(tick, 30_000);
        timer.unref();
        this.timers.set(path, timer);
      });
    };
    const timer = setTimeout(tick, 0);
    timer.unref();
    this.timers.set(path, timer);
  }

  sync(path: string): Promise<void> {
    const previous = this.running.get(path);
    if (previous) return previous;
    const work = this.run(path).then(() => { this.errors.delete(path); }).catch(error => {
      this.errors.set(path, error instanceof Error ? error.message : String(error));
      throw error;
    }).finally(() => { this.running.delete(path); });
    this.running.set(path, work);
    return work;
  }

  private async run(path: string) {
    if (!(await stat(path)).isDirectory()) throw new Error("프로젝트 폴더를 찾을 수 없습니다.");
    // Complete the scan before changing remote data. A read error must never look like source deletion.
    const sources = await collectMemorySources(path);
    if (this.learning) {
      await this.learning.refresh(path).catch(error => console.warn("[Hindsight] Preference learning:", String(error)));
      const guidance = await this.learning.guidance(path);
      if (guidance) sources.push({ key: "author-preferences", content: guidance, context: "Inferred author editing preferences supported by repeated observations; current instructions take precedence." });
    }
    const bankId = await this.client.bankForProject(path);
    const dir = join(path, ".scholarpen");
    const filename = join(dir, "hindsight-sync.json");
    let state: SyncState = { version: 1, bankId, sources: {} };
    try {
      const saved: unknown = JSON.parse(await readFile(filename, "utf8"));
      if (!validState(saved) || saved.bankId !== bankId) throw new Error("프로젝트 기억 동기화 기록을 읽을 수 없습니다.");
      state = saved;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const save = async () => {
      await mkdir(dir, { recursive: true });
      const temp = `${filename}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
      await rename(temp, filename);
    };
    for (const item of Object.values(state.sources)) {
      if (item.state !== "processing") continue;
      item.state = (await this.client.operation(path, item.operationId)).state;
      await save();
      if (item.state === "failed") throw new Error("Hindsight가 편집 관찰을 처리하지 못했습니다. 기록은 보존되며 다음 동기화에서 다시 시도합니다.");
    }
    const current = new Set(sources.map(source => sourceDocumentId(source.key)));
    for (const [id, item] of Object.entries(state.sources)) {
      if (current.has(id) || item.state === "processing") continue;
      await this.client.deleteAutoSource(path, id);
      delete state.sources[id];
      await save();
    }
    let slots = Math.max(0, 4 - Object.values(state.sources).filter(item => item.state === "processing").length);
    for (const source of sources) {
      const id = sourceDocumentId(source.key);
      const digest = hash(JSON.stringify([source.content, source.context]));
      const saved = state.sources[id];
      if (saved?.state === "processing" || (saved?.hash === digest && saved.state === "completed")) continue;
      if (!slots) break;
      const receipt = await this.client.retainAutoSource(path, source, id);
      state.sources[id] = { hash: digest, operationId: receipt.operationId, state: "processing" };
      await save();
      slots--;
    }
  }
}

function validState(value: unknown): value is SyncState {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
      !("bankId" in value) || typeof value.bankId !== "string" || !("sources" in value) ||
      !value.sources || typeof value.sources !== "object" || Array.isArray(value.sources)) return false;
  return Object.entries(value.sources).every(([id, entry]) => /^scholarpen-auto-[a-f0-9]{64}$/.test(id) &&
    entry && typeof entry === "object" && typeof entry.hash === "string" && typeof entry.operationId === "string" &&
    ["processing", "completed", "failed"].includes(entry.state));
}
