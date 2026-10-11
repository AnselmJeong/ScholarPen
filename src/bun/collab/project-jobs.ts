import type { ProjectJobStatus } from "../../shared/manuscript-map";

/**
 * Long project-wide AI work (the manuscript map, the consistency check) runs
 * in the background, one job per project and kind; the UI polls its status.
 */
export class ProjectJobs {
  private readonly jobs = new Map<string, ProjectJobStatus & { controller?: AbortController }>();

  constructor(private readonly now: () => number = Date.now) {}

  status(projectPath: string, kind: string): ProjectJobStatus {
    const { controller: _, ...status } = this.jobs.get(`${projectPath}::${kind}`) ?? { state: "idle" as const };
    return status;
  }

  /** Starts `work` unless the same job is already running; never throws to the caller. */
  start(projectPath: string, kind: string, work: (signal: AbortSignal, progress: (detail: string) => void) => Promise<void>) {
    const key = `${projectPath}::${kind}`;
    if (this.jobs.get(key)?.state === "running") return this.status(projectPath, kind);
    const controller = new AbortController();
    const job: ProjectJobStatus & { controller?: AbortController } = { state: "running", startedAt: this.now(), controller };
    this.jobs.set(key, job);
    void work(controller.signal, detail => { job.detail = detail; })
      .then(() => Object.assign(job, { state: "done", detail: undefined, finishedAt: this.now() }))
      .catch(error => Object.assign(job, { state: "failed", error: error instanceof Error ? error.message : String(error), finishedAt: this.now() }));
    return this.status(projectPath, kind);
  }

  dispose() {
    for (const job of this.jobs.values()) job.controller?.abort();
  }
}
