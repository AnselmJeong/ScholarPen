import { readFile, realpath } from "node:fs/promises";
import { fileSystem } from "../fs/manager";
import type { CollabRegistry, CollabSession } from "../collab/registry";

/** Where the author's decisions on Review & Revision proposals can be read. */
export interface DecisionSources {
  /** The document's live shared state, when an editor has it open. */
  openSession(project: string, filename: string): Promise<CollabSession | null>;
  /** The persisted shared state of a closed document. */
  storedState(project: string, filename: string): Promise<Uint8Array | null>;
  /** The saved (accepted) manuscript JSON of a closed document. */
  documentJSON(project: string, filename: string): Promise<unknown>;
}

let registry: CollabRegistry | null = null;

/** The app's collaboration registry, so review views can read open documents. */
export function linkReviewRegistry(value: CollabRegistry) {
  registry = value;
}

/** Project folders of the documents open in an editor. */
export function openDocumentProjects(): string[] {
  return (registry?.list() ?? []).map(session => session.projectPath);
}

async function root(path: string) {
  return realpath(await fileSystem.resolveProjectPath(path)).catch(() => path);
}

export function decisionSources(): DecisionSources {
  return {
    async openSession(project, filename) {
      for (const session of registry?.list() ?? []) {
        if (session.filename === filename && await root(session.projectPath) === project) return session;
      }
      return null;
    },
    async storedState(project, filename) {
      try { return new Uint8Array(await readFile(await fileSystem.collabStatePath(project, filename))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    },
    documentJSON: (project, filename) => fileSystem.loadDocument(project, filename),
  };
}
