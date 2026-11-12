import { validateManifest, validateValue, type CommandHandler, type ExtensionInfo, type ExtensionRequest, type PluginEntry } from "./contracts";

interface Instance {
  entry: PluginEntry;
  enabled: boolean;
  state: ExtensionInfo["state"];
  activation?: Promise<void>;
  handlers: Map<string, CommandHandler>;
  disposers: Array<() => void | Promise<void>>;
  error?: string;
}

/** Only host-supplied catalog entries are executable. Manifest IDs never authorize code. */
export class ExtensionHost {
  private instances = new Map<string, Instance>();
  private owners = new Map<string, Instance>();
  private requests = new Map<string, { instance: Instance; abort: AbortController }>();
  private changing = new Set<string>();
  private consumed = new Map<string, number>();

  constructor(entries: PluginEntry[], disabled: string[] = [], private persist: (disabled: string[]) => Promise<void> = async () => {}) {
    for (const entry of entries) {
      validateManifest(entry.manifest);
      if (this.instances.has(entry.manifest.id)) throw new Error("Duplicate plugin ID.");
      const enabled = !disabled.includes(entry.manifest.id);
      const instance: Instance = { entry, enabled, state: enabled ? "inactive" : "disabled", handlers: new Map(), disposers: [] };
      this.instances.set(entry.manifest.id, instance);
      for (const command of entry.manifest.contributes.commands) {
        if (this.owners.has(command.id)) throw new Error("Duplicate command ID.");
        this.owners.set(command.id, instance);
      }
    }
  }

  list(): ExtensionInfo[] {
    return [...this.instances.values()].map(i => ({ manifest: i.entry.manifest, enabled: i.enabled, state: i.state,
      running: [...this.requests.values()].filter(r => r.instance === i).length, ...(i.error ? { error: i.error } : {}) }));
  }

  isEnabled(id: string): boolean { return this.instances.get(id)?.enabled === true; }

  private async cleanup(instance: Instance) {
    instance.handlers.clear();
    const disposers = instance.disposers.splice(0).reverse();
    await Promise.allSettled(disposers.map(dispose => Promise.resolve().then(dispose)));
  }

  private activate(instance: Instance): Promise<void> {
    if (instance.state === "active") return Promise.resolve();
    if (instance.activation) return instance.activation;
    instance.state = "activating";
    instance.error = undefined;
    instance.activation = (async () => {
      try {
        const plugin = await instance.entry.load();
        await plugin.activate({
          register: (id, handler) => {
            if (this.owners.get(id) !== instance || instance.handlers.has(id)) throw new Error("Undeclared or duplicate command registration.");
            instance.handlers.set(id, handler);
          },
          onDispose: dispose => { instance.disposers.push(dispose); },
        });
        if (instance.handlers.size !== instance.entry.manifest.contributes.commands.length) throw new Error("Plugin did not register its declared commands.");
        instance.state = "active";
      } catch (error) {
        await this.cleanup(instance);
        instance.state = "failed";
        instance.error = "Activation failed. Retry the command or re-enable the plugin.";
        throw error;
      } finally { instance.activation = undefined; }
    })();
    return instance.activation;
  }

  async invoke(request: ExtensionRequest): Promise<unknown> {
    if (!request || request.protocolVersion !== 1 || typeof request.requestId !== "string" || !/^[\w.-]{1,128}$/.test(request.requestId) ||
        typeof request.operation !== "string" || JSON.stringify(request).length > 8_000_000) throw new Error("Invalid extension request.");
    for (const [id, time] of this.consumed) if (Date.now() - time > 300_000) this.consumed.delete(id);
    if (this.requests.has(request.requestId) || this.consumed.has(request.requestId)) throw new Error("Duplicate request ID; operation was not repeated.");
    if (this.requests.size >= 32) throw new Error("Too many extension operations.");
    const instance = this.owners.get(request.operation);
    if (!instance || !instance.enabled || this.changing.has(instance.entry.manifest.id)) throw new Error("This extension is disabled or unavailable.");
    const command = instance.entry.manifest.contributes.commands.find(c => c.id === request.operation)!;
    validateValue(command.input, request.args);
    if (this.consumed.size >= 256) this.consumed.delete(this.consumed.keys().next().value!);
    this.consumed.set(request.requestId, Date.now());
    const abort = new AbortController();
    this.requests.set(request.requestId, { instance, abort });
    try {
      await this.activate(instance);
      abort.signal.throwIfAborted();
      if (!instance.enabled) throw new Error("Extension disabled.");
      const result = await instance.handlers.get(command.id)!(request.args, abort.signal);
      if (command.output) validateValue(command.output, result, "output");
      return result;
    } finally { this.requests.delete(request.requestId); }
  }

  cancel(requestId: string): void { this.requests.get(requestId)?.abort.abort(); }

  /** Host-only lease for migrated collaboration workflows; never exposed over RPC. */
  async runTask<T>(id: string, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const instance = this.instances.get(id);
    if (!instance?.enabled || this.changing.has(id)) throw new Error("This extension is disabled or unavailable.");
    const requestId = crypto.randomUUID(), abort = new AbortController();
    this.requests.set(requestId, { instance, abort });
    try { return await work(signal ? AbortSignal.any([signal, abort.signal]) : abort.signal); }
    finally { this.requests.delete(requestId); }
  }

  /** The first part runs synchronously: app quit blocks the event loop right after before-quit, so disposers
   * (for example killing an installer's child processes) must start before the first await. */
  async dispose(): Promise<void> {
    for (const request of this.requests.values()) request.abort.abort();
    const pending: unknown[] = [];
    for (const instance of this.instances.values()) {
      instance.handlers.clear();
      for (const dispose of instance.disposers.splice(0).reverse()) {
        try { pending.push(dispose()); } catch { /* One failing disposer must not skip the others. */ }
      }
    }
    await Promise.allSettled(pending);
    await Promise.allSettled([...this.instances.values()].map(async instance => {
      await instance.activation?.catch(() => {});
      await this.cleanup(instance);
    }));
  }

  async setEnabled(id: string, enabled: boolean): Promise<ExtensionInfo[]> {
    const instance = this.instances.get(id);
    if (!instance || typeof enabled !== "boolean") throw new Error("Unknown extension or invalid state.");
    if (this.changing.size) throw new Error("An extension setting is being saved. Try again.");
    if (instance.enabled === enabled) return this.list();
    // Legacy writes/renders cannot all abort safely yet. Never tear one down mid-commit.
    if ([...this.requests.values()].some(r => r.instance === instance)) throw new Error("Wait for this extension's running operation to finish before disabling it.");
    this.changing.add(id);
    try {
      const disabled = [...this.instances.values()].filter(i => i === instance ? !enabled : !i.enabled).map(i => i.entry.manifest.id);
      await this.persist(disabled);
      instance.enabled = enabled;
      if (!enabled) await this.cleanup(instance);
      instance.state = enabled ? "inactive" : "disabled";
      instance.error = undefined;
      return this.list();
    } finally { this.changing.delete(id); }
  }
}
