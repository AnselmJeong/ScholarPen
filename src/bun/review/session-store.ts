import { parseInput } from "../../shared/review-session/schema";
import { mkdir, readFile, readdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ReviewInput, ReviewSession } from "../../shared/review-session/types";
import { atomicWrite, copyPackage, scopedPath, snapshot, writeJSON, readJSON, exists } from "./workspace";
export class SessionStore {
  constructor(readonly project: string) {}
  async root(id: string) {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}-(virtual|peer)-[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid session ID");
    return scopedPath(this.project, `reviews/${id}`);
  }
  async create(input: ReviewInput, baselineSource = this.project) {
    const id = `${new Date().toISOString().slice(0, 10)}-${input.mode}-${randomUUID()}`;
    const root = await this.root(id); await mkdir(root, { recursive: true });
    const baseline = await snapshot(baselineSource, join(root, "original/project"), input.documents);
    await copyPackage(join(root, "original/project"), join(root, "workspace/project"));
    const s: ReviewSession = { schemaVersion: 1, id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), input,
      roles: { reviewer: { provider: "codex", model: input.reviewerModel }, reviser: { provider: "anthropic", model: input.reviserModel } },
      status: "created", stage: "review-ready", quality: "not-assessed", allocatedCycles: 0, completedCycles: 0, selectedFinalRound: null,
      comments: [], approvals: [], rounds: [], error: null, runId: null, manifest: baseline, providerVersions: { codex: "unknown", anthropic: "unknown" }, exportedPaths: [] };
    await writeJSON(root, "manifest.json", baseline);
    await atomicWrite(root, "inputs/decision-letter.txt", input.decisionLetter);
    for (const reviewer of input.reviewers) await atomicWrite(root, `inputs/${reviewer.id}-original.txt`, reviewer.original);
    await this.save(s); return s;
  }
  async load(id: string): Promise<ReviewSession> {
    const s = await readJSON<ReviewSession>(await this.root(id), "session.json");
    if (s.schemaVersion !== 1 || s.id !== id || s.input.projectPath !== this.project || s.allocatedCycles > 2 || s.allocatedCycles < s.completedCycles) throw new Error("Invalid review session manifest");
    parseInput(s.input);
    if (s.roles.reviewer.provider !== "codex" || s.roles.reviser.provider !== "anthropic" || s.roles.reviewer.model !== s.input.reviewerModel || s.roles.reviser.model !== s.input.reviserModel || !Number.isInteger(s.allocatedCycles) || !Number.isInteger(s.completedCycles) || s.allocatedCycles < 0 || s.completedCycles < 0) throw new Error("Invalid role or cycle configuration");
    return s;
  }
  async save(session: ReviewSession) { session.updatedAt = new Date().toISOString(); await writeJSON(await this.root(session.id), "session.json", session); }
  async list() {
    if (!await exists(this.project, "reviews")) return [];
    const sessions: ReviewSession[] = [];
    for (const item of await readdir(await scopedPath(this.project, "reviews"), { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      try { sessions.push(await this.load(item.name)); } catch { /* Uncommitted snapshots are never presented as sessions. */ }
    }
    return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async event(id: string, event: Record<string, unknown>) {
    const root = await this.root(id); const dir = await scopedPath(root, ".state"); await mkdir(dir, { recursive: true });
    const file = await open(await scopedPath(root, ".state/journal.jsonl"), "a");
    try { await file.write(JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n"); await file.sync(); } finally { await file.close(); }
  }
  async lock(id: string) {
    const root = await this.root(id); await mkdir(await scopedPath(root, ".state"), { recursive: true });
    const path = await scopedPath(root, ".state/writer.lock");
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const fd = await open(path, "wx"); await fd.writeFile(JSON.stringify({ pid: process.pid, token })); await fd.close();
        return async () => { const value = JSON.parse(await readFile(path, "utf8")); if (value.token === token) await unlink(path); };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        let pid: number; try { pid = JSON.parse(await readFile(path, "utf8")).pid; } catch { throw new Error("Review lock is incomplete; another process may be starting."); }
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid review lock");
        try { process.kill(pid, 0); throw new Error("이 세션은 다른 실행이 사용 중입니다."); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        await unlink(path);
      }
    }
    throw new Error("Could not acquire review lock");
  }
}
