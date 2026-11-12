import { writingPreferences } from "../ai/writing-preferences";
import { completeLocalStyleModel } from "./local-style-model";
import { homedir } from "node:os";
import { join } from "node:path";
import { extensionEnabled, runExtensionTask } from "./runtime";
import { ProjectScheduler } from "./project-scheduler";
import type { AuthorStyleService } from "../../plugins/author-style/main/service";
import type { StyleRequest, StyleCommand } from "../../shared/author-style";

let service: Promise<AuthorStyleService> | undefined;
export function getAuthorStyle() {
  return service ??= Promise.all([import("../../plugins/author-style/main/service"), import("../../plugins/author-style/main/profiles"), import("../memory/sources")])
    .then(([{ AuthorStyleService }, { ProfileRepository }, { collectAuthorObservations }]) => {
      const provider = async () => {
        const { fileSystem } = await import("../fs/manager"); const settings = await fileSystem.getSettings();
        let local = false;
        try { const url = new URL(settings.ollamaBaseUrl); local = settings.sidebarAgentProvider === "ollama" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !/cloud/i.test(settings.sidebarAgentModel || settings.ollamaDefaultModel); } catch { /* invalid configuration is not local */ }
        return { settings, local, label: `${settings.sidebarAgentProvider} / ${settings.sidebarAgentModel || settings.ollamaDefaultModel}` };
      };
      return new AuthorStyleService(new ProfileRepository(process.env.SCHOLARPEN_PROFILE_HOME ||
        (process.env.SCHOLARPEN_HOME ? join(process.env.SCHOLARPEN_HOME, ".plugins/author-style") : join(homedir(), "Library/Application Support/dev.scholarpen.app/author-style")), collectAuthorObservations), {
        punctuation: async () => (await writingPreferences.read()).punctuation,
        info: async () => { const p = await provider(); return { label: p.label, local: p.local }; },
        complete: async (messages, signal, localOnly) => {
          const { settings, local } = await provider();
          if (localOnly && !local) throw new Error("로컬 전용 분석입니다. 로컬 Ollama 모델을 선택하세요.");
          if (local) return completeLocalStyleModel(settings.ollamaBaseUrl, settings.sidebarAgentModel || settings.ollamaDefaultModel, messages, signal);
          const { completeAgentModel } = await import("../agent/providers");
          return completeAgentModel({ provider: settings.sidebarAgentProvider, model: settings.sidebarAgentModel, messages, signal, maxTokens: 3000, temperature: 0 }, settings);
        },
      });
    });
}
export const authorStyle = {
  execute: async (path: string, command: StyleCommand, signal: AbortSignal) => (await getAuthorStyle()).execute(path, command, signal),
  context: async (path: string | undefined, request: StyleRequest) => extensionEnabled("scholarpen.author-style") ? (await getAuthorStyle()).context(path, request) : { text: "" },
  refresh: async (path: string) => {
    if (extensionEnabled("scholarpen.author-style")) await runExtensionTask("scholarpen.author-style", async signal => (await getAuthorStyle()).refresh(path, signal));
  },
};
export const authorStyleScheduler = new ProjectScheduler(authorStyle.refresh, 300_000);
