/** One open project at a time. Does not depend on remote services. */
export class ProjectScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  constructor(private refresh: (path: string) => Promise<void>, private interval = 30_000) {}
  start(path: string) {
    this.stop();
    const generation = this.generation;
    const tick = async () => {
      try { await this.refresh(path); } catch { /* The feature's view owns its error state. */ }
      if (this.generation !== generation) return;
      this.timer = setTimeout(tick, this.interval);
      this.timer.unref();
    };
    this.timer = setTimeout(tick, 0); this.timer.unref();
  }
  stop() { ++this.generation; clearTimeout(this.timer); this.timer = undefined; }
}
