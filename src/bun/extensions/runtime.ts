import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { ExtensionHost } from "../../shared/extensions/host";
import { bundledEntries } from "./catalog.generated";
import type { ExtensionServices } from "./services";

let host: ExtensionHost | undefined;
const target = join(process.env.SCHOLARPEN_HOME || join(homedir(), "ScholarPen"), "extensions.json");
export async function initializeExtensions(services: ExtensionServices): Promise<ExtensionHost> {
  if (host) return host;
  let disabled: string[] = [];
  try {
    const value: unknown = JSON.parse(await readFile(target, "utf8"));
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("disabled" in value) ||
        !Array.isArray(value.disabled) || !value.disabled.every(id => typeof id === "string")) throw new Error("Invalid extension settings.");
    disabled = value.disabled;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Fail closed, preserve the corrupt file, and keep the document shell usable.
      disabled = bundledEntries(services).map(e => e.manifest.id);
      console.warn("[Extensions] Settings could not be read; all bundled extensions disabled for this session.");
    }
  }
  host = new ExtensionHost(bundledEntries(services), disabled, async ids => {
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, disabled: ids }, null, 2), { mode: 0o600 });
    await rename(temp, target);
  });
  return host;
}
export function extensionEnabled(id: string): boolean { return host ? host.isEnabled(id) : true; }
export function requireExtension(id: string): void {
  if (!extensionEnabled(id)) throw new Error("This feature is disabled. Enable its plugin in Settings → Extensions.");
}
export function runExtensionTask<T>(id: string, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  return host ? host.runTask(id, work, signal) : work(signal ?? new AbortController().signal);
}
export async function shutdownExtensions(): Promise<void> {
  if (!host) return;
  await host.dispose();
}
