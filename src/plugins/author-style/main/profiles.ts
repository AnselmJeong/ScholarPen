import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_STYLE_CONFIG, detectStyleLanguage, type StyleState, type StyleProfile, type StyleRule, type StyleConfig } from "../../../shared/author-style";
import { isRecord } from "../../../shared/extensions/contracts";
import { parsePreferences } from "./analyzer";
import type { AuthorObservation } from "../../../shared/author-learning";

export const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
export function string(value: unknown, label: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label}: 올바른 텍스트를 입력하세요 (최대 ${max}자).`);
  return value.trim();
}
export function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("잘못된 문체 요청입니다."); return value;
}
export function rules(value: unknown): StyleRule[] {
  if (!Array.isArray(value) || value.length > 40) throw new Error("프로필 규칙은 최대 40개입니다.");
  const ids = new Set<string>();
  return value.map(v => {
    const r = object(v), id = string(r.id, "규칙 ID", 100);
    if (ids.has(id)) throw new Error("중복 규칙 ID입니다."); ids.add(id);
    if (!["learned", "explicit"].includes(String(r.source)) || !["candidate", "active", "dismissed"].includes(String(r.status)) ||
        !["repeated", "author-confirmed", "insufficient"].includes(String(r.support)) || !Array.isArray(r.evidenceIds) ||
        !r.evidenceIds.every(id => typeof id === "string" && id.length <= 200) || r.evidenceIds.length > 120) throw new Error("잘못된 문체 규칙입니다.");
    return { id, instruction: string(r.instruction, "규칙", 500), language: string(r.language, "언어", 30),
      genre: string(r.genre, "장르", 100), evidenceIds: r.evidenceIds as string[], source: r.source as StyleRule["source"],
      status: r.status as StyleRule["status"], support: r.support as StyleRule["support"] };
  });
}
export function profile(value: unknown): StyleProfile {
  const p = object(value);
  if (!Number.isInteger(p.revision) || Number(p.revision) < 1) throw new Error("잘못된 프로필 버전입니다.");
  return { id: string(p.id, "프로필 ID", 100), authorId: string(p.authorId, "저자 ID", 100), name: string(p.name, "이름", 100),
    revision: Number(p.revision), language: string(p.language, "언어", 30), genre: string(p.genre, "장르", 100), rules: rules(p.rules),
    createdAt: string(p.createdAt, "생성일", 100), updatedAt: string(p.updatedAt, "수정일", 100) };
}
export function config(value: unknown): StyleConfig {
  const c: Record<string, unknown> = { genre: "academic", ...object(value) };
  const keys = Object.keys(DEFAULT_STYLE_CONFIG);
  if (Object.keys(c).some(key => !keys.includes(key)) || keys.some(key => !(key in c))) throw new Error("잘못된 문체 설정입니다.");
  for (const key of keys.filter(k => k !== "strength" && k !== "genre")) if (typeof c[key] !== "boolean") throw new Error("잘못된 문체 설정입니다.");
  if (!["academic", "explanation", "any"].includes(String(c.genre))) throw new Error("잘못된 글 유형입니다.");
  if (!["off", "light", "normal", "strong"].includes(String(c.strength))) throw new Error("잘못된 적용 강도입니다.");
  return c as unknown as StyleConfig;
}
function validate(value: unknown): StyleState {
  const s = object(value);
  if (s.schemaVersion !== 1 || !Number.isInteger(s.revision) || Number(s.revision) < 0 || !Array.isArray(s.profiles) || !Array.isArray(s.evidence) ||
      !Array.isArray(s.exclusions) || !s.exclusions.every(x => typeof x === "string") || !Array.isArray(s.history) || !Array.isArray(s.applications) ||
      (s.activeProfileId !== null && typeof s.activeProfileId !== "string") || typeof s.lastAnalysisHash !== "string") throw new Error("문체 저장소가 손상되었습니다. 원본은 보존됩니다.");
  string(s.authorId, "저자 ID", 100); s.config = config(s.config); s.profiles.forEach(profile); s.history.forEach(profile);
  if (s.personalProfileId !== undefined && s.personalProfileId !== null && typeof s.personalProfileId !== "string") throw new Error("잘못된 개인 프로필 연결입니다.");
  for (const item of s.evidence) {
    const e = object(item);
    for (const key of ["id", "profileId", "authorId", "kind", "label", "language", "genre", "text", "hash"]) string(e[key], key, key === "text" ? 60_000 : 500);
    if (!["author-sample", "direct-edit", "accepted", "rejected"].includes(String(e.kind)) || typeof e.observedAt !== "number") throw new Error("잘못된 문체 근거입니다.");
  }
  return s as unknown as StyleState;
}

/** One atomic, versioned private record per project. Never writes evidence into the shared Y.Doc. */
export class ProfileRepository {
  private queues = new Map<string, Promise<unknown>>();
  readonly authorId: string;
  constructor(readonly root: string, private legacyObservations: (path: string) => Promise<AuthorObservation[]> = async () => []) {
    this.authorId = `local-${fingerprint(resolve(root)).slice(0, 24)}`;
  }
  private file(path: string) { return join(this.root, `${fingerprint(resolve(path))}.json`); }
  private serial<T>(path: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work); this.queues.set(path, next);
    void next.finally(() => { if (this.queues.get(path) === next) this.queues.delete(path); }).catch(() => {});
    return next;
  }
  private async write(path: string, state: StyleState) {
    validate(state);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = this.file(path), temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 }); await rename(temp, target);
  }
  private async load(path: string): Promise<StyleState> {
    try { return validate(JSON.parse(await readFile(this.file(path), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const state: StyleState = { schemaVersion: 1, revision: 0, authorId: this.authorId, profiles: [], evidence: [], activeProfileId: null,
      config: { ...DEFAULT_STYLE_CONFIG }, exclusions: [], history: [], applications: [], migration: null, lastAnalysisHash: "" };
    let raw: string;
    try { raw = await readFile(join(path, ".scholarpen/author-preferences.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await this.write(path, state); return state; }
    const legacy = object(JSON.parse(raw));
    if (legacy.version !== 1 || !Array.isArray(legacy.preferences) || !Array.isArray(legacy.excludedEvidence) ||
        !legacy.excludedEvidence.every(x => typeof x === "string")) throw new Error("기존 편집 취향 파일을 이전할 수 없습니다. 원본을 보존했습니다.");
    const observations = (await this.legacyObservations(path)).filter(o => !(legacy.excludedEvidence as string[]).includes(o.id));
    const learned = parsePreferences(JSON.stringify(legacy), observations);
    for (const language of new Set(observations.map(o => detectStyleLanguage(o.after)))) {
      const entries = observations.filter(o => detectStyleLanguage(o.after) === language);
      const p = this.newProfile(state, `이전한 문체 (${language})`, language, "academic");
      for (const o of entries) state.evidence.push({ id: o.id, profileId: p.id, authorId: this.authorId, kind: o.kind,
        label: o.filename, language, genre: p.genre, text: o.after, hash: fingerprint(o.id), observedAt: o.observedAt, observation: o });
      p.rules = learned.filter(r => r.evidenceIds.every(id => entries.some(o => o.id === id))).map(r => ({ id: r.id,
        instruction: `${r.rule} (${r.scope})`, language, genre: p.genre, evidenceIds: r.evidenceIds, source: "learned", status: "active", support: "repeated" }));
    }
    state.config.observe = true; // Preserve project-local observation, never infer remote consent.
    state.exclusions = (legacy.excludedEvidence as string[]).map(fingerprint);
    state.migration = { sourceHash: fingerprint(raw), at: new Date().toISOString() };
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const backup = `${this.file(path)}.legacy-backup`;
    try { await writeFile(backup, raw, { mode: 0o600, flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await this.write(path, state); return state;
  }
  read(path: string) { return this.serial(path, () => this.load(path)); }
  change(path: string, expected: number | undefined, mutate: (state: StyleState) => void | Promise<void>, bumpRevision = true) {
    return this.serial(path, async () => {
      const state = await this.load(path);
      if (expected !== undefined && state.revision !== expected) throw new Error("프로필이 다른 창에서 변경되었습니다. 새로고침 후 다시 시도하세요.");
      await mutate(state); if (bumpRevision) state.revision++; await this.write(path, state); return state;
    });
  }
  newProfile(state: StyleState, name: string, language: string, genre: string) {
    if (state.profiles.length >= 30) throw new Error("프로필은 프로젝트당 최대 30개입니다.");
    const now = new Date().toISOString();
    const p: StyleProfile = { id: randomUUID(), name, authorId: state.authorId, revision: 1, language, genre, rules: [], createdAt: now, updatedAt: now };
    state.profiles.push(p);
    if (!state.activeProfileId) { state.activeProfileId = p.id; if (["academic", "explanation", "any"].includes(genre)) state.config.genre = genre as StyleConfig["genre"]; }
    return p;
  }
  checkpoint(state: StyleState, p: StyleProfile) {
    state.history.push(structuredClone(p)); state.history = state.history.slice(-30);
    p.revision++; p.updatedAt = new Date().toISOString();
  }
}

/** Only explicitly submitted prose is retained. Quotes, code, references and URLs are excluded. */
export function sampleProse(text: string): string {
  return text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "")
    .replace(/^\s*>.*$/gm, "").replace(/^(?:#{1,6}\s*)?(?:references|bibliography|참고문헌)\s*\n[\s\S]*$/im, "")
    .replace(/https?:\/\/\S+/g, "").replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, "").trim();
}
