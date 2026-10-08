import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  normalizeReviewCategories,
  normalizeReviewCategory,
  PROJECT_REVIEW_SETTINGS_KEY,
  REVIEW_MAP,
  type ProjectReviewSettings,
} from "../../shared/collab/review";
import { BUN_PEER_ID } from "../../shared/collab/protocol";
import type { CollabSession } from "./registry";

/** One policy per project. Writes are serialized so toggles in two editors cannot overwrite each other. */
export class ProjectReviewSettingsStore {
  private readonly pending = new Map<string, Promise<ProjectReviewSettings>>();

  private async projectRoot(projectPath: string) {
    const root = await realpath(projectPath);
    if (!(await stat(root)).isDirectory()) throw new Error("The project folder is not a directory.");
    return root;
  }

  private async read(root: string): Promise<ProjectReviewSettings> {
    let source: string;
    try {
      source = await readFile(join(root, ".scholarpen", "review-settings.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { disabledCategories: [] };
      throw error;
    }
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== "object" || !("disabledCategories" in value) || !Array.isArray(value.disabledCategories)) {
      throw new Error("Invalid project review settings. Expected disabledCategories to be an array.");
    }
    return { disabledCategories: normalizeReviewCategories(value.disabledCategories) };
  }

  async get(projectPath: string) {
    const root = await this.projectRoot(projectPath);
    await this.pending.get(root);
    return this.read(root);
  }

  async setCategory(projectPath: string, category: string, enabled: boolean): Promise<ProjectReviewSettings> {
    const canonical = normalizeReviewCategory(category);
    if (!canonical || typeof enabled !== "boolean") throw new Error("Unknown review category or invalid enabled flag.");
    const root = await this.projectRoot(projectPath);
    const previous = this.pending.get(root);
    const work = (async () => {
      await previous?.catch(() => undefined);
      const current = await this.read(root);
      const disabled = new Set(current.disabledCategories);
      if (enabled) disabled.delete(canonical);
      else disabled.add(canonical);
      const settings: ProjectReviewSettings = { disabledCategories: normalizeReviewCategories([...disabled]) };
      const dir = join(root, ".scholarpen");
      await mkdir(dir, { recursive: true });
      const path = join(dir, "review-settings.json");
      const temp = `${path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(settings, null, 2) + "\n");
      await rename(temp, path);
      return settings;
    })();
    this.pending.set(root, work);
    try {
      return await work;
    } finally {
      if (this.pending.get(root) === work) this.pending.delete(root);
    }
  }
}

/** Mirror the authoritative file policy into each open Y.Doc for live UI and reviewer updates. */
export function applyProjectReviewSettings(sessions: Array<Pick<CollabSession, "ydoc" | "projectPath">>, projectPath: string, settings: ProjectReviewSettings) {
  for (const session of sessions) {
    if (session.projectPath !== projectPath) continue;
    session.ydoc.transact(() => {
      session.ydoc.getMap(REVIEW_MAP).set(PROJECT_REVIEW_SETTINGS_KEY, settings);
    }, BUN_PEER_ID);
  }
}
