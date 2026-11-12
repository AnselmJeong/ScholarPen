import type { fileSystem } from "../fs/manager";
import type { BibliographyValidationProgress } from "../../shared/rpc-types";
import { authorStyle } from "./author-style";
interface HostServices {
  fileSystem: typeof fileSystem;
  recentlySavedFiles: Set<string>; internallyUpdatingProjects: Set<string>;
  sendProjectUpdated(payload: { projectPath: string; filePath?: string }): void;
  sendBibliographyValidationProgress(payload: BibliographyValidationProgress): void;
  buildSubprocessEnv(): Record<string, string>;
}
/** Each bundled module receives only its host operations, never the whole application. */
export function createExtensionServices(host: HostServices) {
  const fs = host.fileSystem;
  const pick = <K extends keyof typeof fs>(...keys: K[]): Pick<typeof fs, K> => Object.fromEntries(keys.map(key => [key,
    typeof fs[key] === "function" ? (fs[key] as Function).bind(fs) : fs[key]])) as Pick<typeof fs, K>;
  return {
    "scholarpen.quarto": { fileSystem: pick("getQuartoProjectDirectory"), sendProjectUpdated: host.sendProjectUpdated, buildSubprocessEnv: host.buildSubprocessEnv },
    "scholarpen.bibliography": { fileSystem: pick("saveBibtex", "saveBibtexRaw", "saveBibtexValidated", "loadBibtex", "mergeBibtex", "getSettings", "scanBibliographyUsage", "saveBibliographyMaintenance", "deduplicateBibliography"),
      recentlySavedFiles: host.recentlySavedFiles, internallyUpdatingProjects: host.internallyUpdatingProjects,
      sendProjectUpdated: host.sendProjectUpdated, sendBibliographyValidationProgress: host.sendBibliographyValidationProgress },
    "scholarpen.author-style": { resolveProjectPath: fs.resolveProjectPath.bind(fs), execute: authorStyle.execute },
    "scholarpen.ai-writing-score": undefined, "scholarpen.document-stats": undefined, "scholarpen.text-cleanup": undefined,
  };
}
export type ExtensionServices = ReturnType<typeof createExtensionServices>;
