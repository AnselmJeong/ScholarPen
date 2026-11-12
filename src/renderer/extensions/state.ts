import { useSyncExternalStore } from "react";
import { bundledManifests } from "../../shared/extensions/catalog.generated";
import type { ExtensionInfo } from "../../shared/extensions/contracts";
import { rpc } from "../rpc";

let snapshot: ExtensionInfo[] = bundledManifests.map(manifest => ({ manifest, enabled: true, state: "inactive", running: 0 }));
const listeners = new Set<() => void>();
const guards = new Map<string, Set<() => void | Promise<void>>>();
/** Views can block teardown while a local draft still needs the author's attention. */
export function registerExtensionGuard(id: string, guard: () => void | Promise<void>) {
  const entries = guards.get(id) ?? new Set();
  entries.add(guard); guards.set(id, entries);
  return () => { entries.delete(guard); if (!entries.size) guards.delete(id); };
}
export async function prepareExtensionDisable(id: string) {
  for (const guard of guards.get(id) ?? []) await guard();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function update(next: ExtensionInfo[]) { snapshot = next; listeners.forEach(listener => listener()); }
export async function initializeExtensionsUI() {
  try { update(await rpc.extensionsList()); }
  catch { update(snapshot.map(info => ({ ...info, enabled: false, state: "failed", error: "Could not load extension state. Reopen Settings to retry." }))); }
}
export async function setExtensionEnabled(id: string, enabled: boolean) { update(await rpc.extensionsSetEnabled(id, enabled)); }
export function useExtensions() { return useSyncExternalStore(subscribe, () => snapshot); }
export function useExtensionEnabled(id: string) { return useExtensions().some(info => info.manifest.id === id && info.enabled); }
export function extensionEnabled(id: string) { return snapshot.some(info => info.manifest.id === id && info.enabled); }
