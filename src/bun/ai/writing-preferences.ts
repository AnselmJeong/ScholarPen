import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_PUNCTUATION, PUNCTUATION_PLACEHOLDER, punctuationFromPrompt, parsePunctuationPolicy, applyPunctuationPolicy, type WritingPreferences } from "../../shared/writing-preferences";
import type { OllamaMessage } from "../../shared/rpc-types";

export class WritingPreferencesStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private root: string) {}
  async read(): Promise<WritingPreferences> {
    try {
      const value: unknown = JSON.parse(await readFile(join(this.root, "writing-preferences.json"), "utf8"));
      if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("revision" in value) ||
          !Number.isInteger(value.revision) || Number(value.revision) < 0 || !("punctuation" in value)) throw new Error("작성 설정을 읽을 수 없습니다. 원본을 보존했습니다.");
      return { version: 1, revision: Number(value.revision), punctuation: parsePunctuationPolicy(value.punctuation) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { version: 1, revision: 0, punctuation: { ...DEFAULT_PUNCTUATION } };
    }
  }
  /** AI requests must not fail because the settings file is unreadable: fall back to the historical defaults.
   * Settings still uses read(), which reports the problem and leaves the stored bytes untouched. */
  async policyForRequest(): Promise<WritingPreferences["punctuation"]> {
    try { return (await this.read()).punctuation; }
    catch (error) {
      if (!this.warned) { this.warned = true; console.warn("[WritingPreferences] Using default punctuation policy:", error instanceof Error ? error.message : error); }
      return { ...DEFAULT_PUNCTUATION };
    }
  }
  private warned = false;
  async save(expectedRevision: number, punctuation: unknown): Promise<WritingPreferences> {
    const policy = parsePunctuationPolicy(punctuation);
    const next = this.queue.catch(() => {}).then(async () => {
      const before = await this.read();
      if (before.revision !== expectedRevision) throw new Error("작성 설정이 변경되었습니다. 새로고침하세요.");
      const value: WritingPreferences = { version: 1, revision: before.revision + 1, punctuation: policy };
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const target = join(this.root, "writing-preferences.json"), temp = `${target}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temp, target); return value;
    }); this.queue = next; return next;
  }
}
export const writingPreferences = new WritingPreferencesStore(process.env.SCHOLARPEN_PROFILE_HOME || process.env.SCHOLARPEN_HOME || join(homedir(), "Library/Application Support/dev.scholarpen.app"));
export async function preparePunctuationMessages(messages: OllamaMessage[]) {
  if (!messages.some(m => m.role === "system" && m.content.includes(PUNCTUATION_PLACEHOLDER))) return messages;
  const captured = messages.filter(m => m.role === "system").map(m => punctuationFromPrompt(m.content)).find(Boolean);
  return applyPunctuationPolicy(messages, captured ?? await writingPreferences.policyForRequest());
}
