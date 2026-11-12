import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PersonalStyleLibrary, StyleProfile } from "../../../shared/author-style";
import { object, profile, string } from "./profiles";

export function validatePersonal(value: unknown, authorId: string): PersonalStyleLibrary {
  const s = object(value);
  if (s.schemaVersion !== 1 || !Number.isInteger(s.revision) || Number(s.revision) < 0 || s.authorId !== authorId ||
      !Array.isArray(s.profiles) || s.profiles.length > 50 || !Array.isArray(s.history) || !Array.isArray(s.defaults) || s.defaults.length > 50 ||
      (s.defaultProfileId !== null && typeof s.defaultProfileId !== "string")) throw new Error("개인 문체 저장소가 올바르지 않습니다. 원본을 보존했습니다.");
  const profiles = s.profiles.map(profile), history = s.history.map(profile);
  if (new Set(profiles.map(p => p.id)).size !== profiles.length) throw new Error("개인 프로필 ID가 중복됩니다.");
  for (const p of [...profiles, ...history]) if (p.authorId !== authorId || p.rules.some(r => r.evidenceIds.length)) throw new Error("개인 프로필에는 프로젝트 근거를 포함할 수 없습니다.");
  if (s.defaultProfileId !== null && !profiles.some(p => p.id === s.defaultProfileId)) throw new Error("개인 기본 프로필을 찾을 수 없습니다.");
  const keys = new Set<string>();
  const defaults = s.defaults.map(value => {
    const d = object(value), language = string(d.language, "언어", 30), genre = string(d.genre, "장르", 100), profileId = string(d.profileId, "프로필", 100);
    const p = profiles.find(p => p.id === profileId), key = `${language}:${genre}`;
    if (!p || keys.has(key) || (p.language !== "any" && p.language !== language) || (p.genre !== "any" && p.genre !== genre)) throw new Error("언어·장르 기본 프로필의 범위가 맞지 않습니다.");
    keys.add(key); return { language, genre, profileId };
  });
  return { schemaVersion: 1, revision: Number(s.revision), authorId, profiles, history, defaults, defaultProfileId: s.defaultProfileId as string | null };
}

/** Explicitly shared rules only. Never stores raw samples, source paths or project evidence IDs. */
export class PersonalProfileRepository {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private root: string, private authorId: string) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(work); this.queue = next; return next;
  }
  private async load(): Promise<PersonalStyleLibrary> {
    try { return validatePersonal(JSON.parse(await readFile(join(this.root, "personal.json"), "utf8")), this.authorId); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { schemaVersion: 1, revision: 0, authorId: this.authorId, profiles: [], defaultProfileId: null, defaults: [], history: [] };
  }
  read() { return this.serial(() => this.load()); }
  change(expected: number, mutate: (state: PersonalStyleLibrary) => void) {
    return this.serial(async () => {
      const state = await this.load();
      if (state.revision !== expected) throw new Error("개인 프로필이 다른 창에서 변경되었습니다. 새로고침하세요.");
      mutate(state); state.revision++; validatePersonal(state, this.authorId);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const target = join(this.root, "personal.json"), temp = `${target}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 }); await rename(temp, target); return state;
    });
  }
  checkpoint(state: PersonalStyleLibrary, p: StyleProfile) {
    state.history = [...state.history, structuredClone(p)].slice(-50); p.revision++; p.updatedAt = new Date().toISOString();
  }
}
