import { resolve } from "node:path";
import type { OllamaMessage } from "../../shared/rpc-types";
import { normalizeGlossary, type Glossary } from "../../shared/glossary";
import type { ManuscriptMap, ManuscriptMapView } from "../../shared/manuscript-map";
import type { ConsistencyReport, ConsistencyView } from "../../shared/consistency-report";
import type { CollabRegistry } from "./registry";
import { ProjectWritingStore } from "./project-store";
import { ProjectJobs } from "./project-jobs";
import { loadProjectDocuments, type ProjectDocument } from "./project-documents";
import { manuscriptMapView, refreshManuscriptMap } from "./agent/manuscript-map";
import { brokenReferences, buildContradictionMessages, duplicatePassages, parseContradictions, postIssues, terminologyIssues } from "./agent/project-consistency";

export interface ProjectWritingDeps {
  complete(messages: OllamaMessage[], signal: AbortSignal, maxTokens: number): Promise<string>;
  /** Overridable for tests; defaults to the project's saved documents. */
  loadDocuments?: (projectPath: string) => Promise<ProjectDocument[]>;
  /** Resolves (and authorizes) a project path; defaults to the file system's check. */
  resolveProject?: (projectPath: string) => Promise<string>;
  now?: () => number;
}

/**
 * Project-wide writing support: the glossary, the manuscript map and the
 * cross-document consistency check. Long AI work runs as background jobs.
 */
export class ProjectWriting {
  readonly store = new ProjectWritingStore();
  private readonly jobs: ProjectJobs;
  private readonly now: () => number;

  constructor(private readonly registry: CollabRegistry, private readonly deps: ProjectWritingDeps) {
    this.now = deps.now ?? Date.now;
    this.jobs = new ProjectJobs(this.now);
  }

  dispose() { this.jobs.dispose(); }

  private async project(projectPath: string) {
    if (this.deps.resolveProject) return this.deps.resolveProject(projectPath);
    const { fileSystem } = await import("../fs/manager");
    return fileSystem.resolveProjectPath(projectPath);
  }

  private documents(projectPath: string) {
    return (this.deps.loadDocuments ?? loadProjectDocuments)(projectPath);
  }

  /** Glossary and map for AI prompts; never throws (a missing file is an empty guide). */
  async guide(projectPath: string): Promise<{ glossary: Glossary; map: ManuscriptMap }> {
    const [glossary, map] = await Promise.all([
      this.store.read(projectPath, "glossary").catch(() => ({ entries: [] })),
      this.store.read(projectPath, "map").catch(() => ({ documents: {} })),
    ]);
    return { glossary, map };
  }

  async getGlossary(projectPath: string) {
    return this.store.read(await this.project(projectPath), "glossary");
  }

  async saveGlossary(projectPath: string, glossary: unknown) {
    const next = { ...normalizeGlossary(glossary), updatedAt: this.now() };
    return this.store.update(await this.project(projectPath), "glossary", () => next);
  }

  async mapView(projectPath: string): Promise<ManuscriptMapView> {
    const root = await this.project(projectPath);
    const [documents, map] = await Promise.all([this.documents(root), this.store.read(root, "map")]);
    return manuscriptMapView(documents, map, this.jobs.status(root, "map"));
  }

  async updateMap(projectPath: string): Promise<ManuscriptMapView> {
    const root = await this.project(projectPath);
    this.jobs.start(root, "map", (signal, progress) => this.refreshMap(root, signal, progress).then(() => undefined));
    return this.mapView(root);
  }

  private async refreshMap(root: string, signal: AbortSignal, progress: (detail: string) => void) {
    return refreshManuscriptMap(await this.documents(root), {
      read: () => this.store.read(root, "map"),
      update: change => this.store.update(root, "map", change),
    }, (messages, callSignal) => this.deps.complete(messages, callSignal, 4096), signal, progress, this.now);
  }

  async consistencyView(projectPath: string): Promise<ConsistencyView> {
    const root = await this.project(projectPath);
    return { report: await this.store.read(root, "report"), job: this.jobs.status(root, "consistency") };
  }

  async runConsistency(projectPath: string): Promise<ConsistencyView> {
    const root = await this.project(projectPath);
    this.jobs.start(root, "consistency", async (signal, progress) => { await this.checkConsistency(root, signal, progress); });
    return this.consistencyView(root);
  }

  /** The whole check; exposed for tests. */
  async checkConsistency(root: string, signal: AbortSignal, progress: (detail: string) => void = () => {}): Promise<ConsistencyReport> {
    progress("Reading the project's documents");
    const documents = await this.documents(root);
    const glossary = await this.store.read(root, "glossary");
    const skipped = documents.filter(document => document.error).map(document => `${document.filename} could not be read: ${document.error}`);
    const issues = [...brokenReferences(documents), ...duplicatePassages(documents), ...terminologyIssues(documents, glossary)];
    // Contradictions are found between map entries, so bring the map up to date first.
    let map: ManuscriptMap | null = null;
    try {
      progress("Updating the manuscript map");
      map = await this.refreshMap(root, signal, progress);
    } catch (error) {
      signal.throwIfAborted();
      skipped.push(`Manuscript map: ${error instanceof Error ? error.message : String(error)}`);
      map = await this.store.read(root, "map");
    }
    if (Object.keys(map.documents).length >= 1) {
      try {
        progress("Comparing claims, definitions and numbers across documents");
        issues.push(...parseContradictions(await this.deps.complete(buildContradictionMessages(map, glossary), signal, 8192), map, documents));
      } catch (error) {
        signal.throwIfAborted();
        skipped.push(`Contradiction check: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else skipped.push("Contradiction check: no document has a manuscript map yet.");
    const unique = [...new Map(issues.map(issue => [issue.id, issue])).values()];
    const sessions = this.registry.list().filter(session => resolve(session.projectPath) === resolve(root));
    const report: ConsistencyReport = { createdAt: this.now(), documents: documents.length, issues: unique, posted: postIssues(sessions, unique), skipped };
    await this.store.update(root, "report", () => report);
    return report;
  }
}
